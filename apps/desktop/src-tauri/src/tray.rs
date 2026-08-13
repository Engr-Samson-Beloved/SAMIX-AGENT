//! System tray (spec §35).
//!
//! The tray is the agent's persistent presence: the app is a background utility
//! that lives here, and the window is just one view onto it. The tooltip carries
//! the current state so the user can tell at a glance whether the agent is idle,
//! listening, working, or waiting for them.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

use crate::sidecar::Sidecar;

pub const TRAY_ID: &str = "samix-tray";

/// Build the tray icon and its menu.
pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Agent", true, None::<&str>)?;
    let listen = MenuItem::with_id(app, "listen", "Start Listening", false, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop Current Task", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "Logs", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Exit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            // Disabled until Phase 2 wires the microphone. Shown rather than
            // hidden so the roadmap is legible in the product itself.
            &listen,
            &stop,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &logs,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().expect("bundled window icon"))
        .tooltip("SAMIX Agent — idle")
        .menu(&menu)
        // Left-click toggles the window; the menu stays on right-click only.
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_window(app),
            "settings" => focus_route(app, "settings"),
            "logs" => focus_route(app, "logs"),
            "stop" => {
                if let Some(sidecar) = app.try_state::<Sidecar>() {
                    let _ = sidecar.request("agent.emergencyStop".into(), serde_json::json!({}));
                }
            }
            "quit" => {
                if let Some(sidecar) = app.try_state::<Sidecar>() {
                    sidecar.stop();
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Reflect agent state in the tray tooltip (spec §35 tray states).
pub fn set_state<R: Runtime>(app: &AppHandle<R>, state: &str) {
    let label = match state {
        "listening" => "listening",
        "transcribing" | "understanding" | "planning" => "thinking",
        "executing" | "observing" | "verifying" | "recovering" => "working",
        "awaiting_confirmation" => "needs confirmation",
        "failed" => "error",
        _ => "idle",
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("SAMIX Agent — {label}")));
    }
}

pub fn show_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_window(app);
        }
    }
}

/// Show the window and ask the frontend to navigate to a pane.
fn focus_route<R: Runtime>(app: &AppHandle<R>, route: &str) {
    show_window(app);
    use tauri::Emitter;
    let _ = app.emit("samix://navigate", route);
}
