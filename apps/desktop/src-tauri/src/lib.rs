//! SAMIX Agent desktop host.
//!
//! The Rust layer owns exactly three things: the window and tray, native
//! integration (global hotkey, single instance), and supervision of the Node
//! agent core. It contains no agent logic — that lives in `@samix/core`
//! (ADR-0001), so the reasoning layer stays in one language and one process.

mod sidecar;
mod tray;

use serde_json::{json, Value};
use tauri::{Emitter, Listener, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use sidecar::{Sidecar, UI_CORE_STATUS_CHANNEL, UI_EVENT_CHANNEL};

/// The single IPC command exposed to the webview.
///
/// Spec §75 forbids a generic native escape hatch. This is deliberately not
/// `run_command(cmd)`: it forwards a *named method* to the core, whose closed
/// method set is validated there against a Zod schema. The webview cannot reach
/// the filesystem, spawn a process, or invoke a tool directly — it can only ask
/// the agent to do something the agent already knows how to do.
#[tauri::command]
async fn samix_request(
    app: tauri::AppHandle,
    method: String,
    params: Value,
) -> Result<Value, String> {
    // The core's protocol is blocking-per-request, so it runs off the async
    // runtime and the UI thread is never held up (spec §76). `app` is moved into
    // the closure and the state is resolved there — borrowing it out here would
    // not outlive the spawned task.
    tauri::async_runtime::spawn_blocking(move || {
        let sidecar = app.state::<Sidecar>();
        sidecar.request(method, params)
    })
    .await
    .map_err(|e| format!("request task failed: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch focuses the existing window instead of starting a
        // second agent. Two agents driving one desktop would be a correctness
        // hazard, not just an annoyance.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_window(app);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(Sidecar::new())
        .invoke_handler(tauri::generate_handler![samix_request])
        .setup(|app| {
            let handle = app.handle().clone();

            tray::create(&handle)?;

            // Start the core before wiring the hotkey, so a hotkey press can
            // never reach a core that is not listening yet.
            if let Err(error) = app.state::<Sidecar>().start(&handle) {
                eprintln!("[host] {error}");
                let _ = handle.emit(
                    UI_CORE_STATUS_CHANNEL,
                    json!({ "status": "failed", "detail": error }),
                );
            } else {
                let _ = handle.emit(UI_CORE_STATUS_CHANNEL, json!({ "status": "running" }));
            }

            register_hotkey(&handle);
            mirror_state_to_tray(&handle);

            // Spec §87: do not start hidden during development, or a developer
            // running `tauri dev` gets no window and no obvious feedback.
            if cfg!(debug_assertions) {
                tray::show_window(&handle);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides to tray; the agent keeps running (spec §35).
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error building SAMIX Agent")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Never leave an orphaned core with the ability to drive the
                // user's desktop.
                if let Some(sidecar) = app.try_state::<Sidecar>() {
                    sidecar.stop();
                }
            }
        });
}

/// Register the emergency-stop / wake hotkey (spec §33, §34).
///
/// Phase 1 wires the emergency stop, which is the half that matters for safety.
/// Wake-to-listen arrives with the microphone in Phase 2.
fn register_hotkey(app: &tauri::AppHandle) {
    let shortcut = Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::SHIFT),
        Code::Space,
    );
    let handle = app.clone();

    let result = app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
        if event.state() != ShortcutState::Pressed {
            return;
        }
        if let Some(sidecar) = handle.try_state::<Sidecar>() {
            let _ = sidecar.request("agent.emergencyStop".into(), json!({}));
        }
        tray::show_window(&handle);
    });

    if let Err(error) = result {
        // Another application may already own the combination. Degrade rather
        // than refusing to launch — the in-app Stop button still works.
        eprintln!("[host] could not register the global hotkey: {error}");
    }
}

/// Keep the tray tooltip in step with the agent's state.
fn mirror_state_to_tray(app: &tauri::AppHandle) {
    let handle = app.clone();
    app.listen(UI_EVENT_CHANNEL, move |event| {
        let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else {
            return;
        };
        if payload.get("type").and_then(Value::as_str) == Some("agent.state.changed") {
            if let Some(state) = payload.get("to").and_then(Value::as_str) {
                tray::set_state(&handle, state);
            }
        }
    });
}
