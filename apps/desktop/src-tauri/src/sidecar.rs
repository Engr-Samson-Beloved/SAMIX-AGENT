//! Supervises the Node agent core as a child process.
//!
//! Protocol: newline-delimited JSON over the child's stdin/stdout (ADR-0003).
//! stdout carries protocol frames only; the core writes all logging to stderr,
//! which we forward to the Tauri log for diagnostics.
//!
//! # Why a child process rather than a Tauri "sidecar binary"
//!
//! The core is a Node program. Spawning it directly with a hard-coded argument
//! vector means there is no shell involved and no `tauri-plugin-shell` scope to
//! get wrong — the command is fixed at compile time and cannot be influenced by
//! the webview or the model. That matches spec §40's rule that the agent never
//! gets an arbitrary shell.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// Channel the webview subscribes to for all agent events.
pub const UI_EVENT_CHANNEL: &str = "samix://event";
/// Emitted when the core dies, so the UI can show a clear failure state rather
/// than silently freezing.
pub const UI_CORE_STATUS_CHANNEL: &str = "samix://core-status";

/// How long a single request may wait for its response before giving up.
/// Development rule 15: every external operation gets a timeout.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum OutboundFrame {
    Response {
        id: String,
        #[serde(flatten)]
        payload: Value,
    },
    Event {
        event: Value,
    },
}

pub struct Sidecar {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    /// Correlates a request id with the channel awaiting its response.
    pending: Arc<Mutex<HashMap<String, Sender<Value>>>>,
    counter: AtomicU64,
}

impl Sidecar {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            counter: AtomicU64::new(0),
        }
    }

    /// Launch the core and start the reader threads.
    pub fn start(&self, app: &AppHandle) -> Result<(), String> {
        // Windows canonicalizes to `\\?\`-prefixed verbatim paths, which Node's
        // CJS loader mishandles as the entry-script argument (it mis-resolves
        // the main path down to the bare drive root and throws EISDIR). Strip
        // the prefix back to a normal drive-letter path before spawning.
        let entry = dunce::simplified(&resolve_core_entry(app)?).to_path_buf();
        let node = dunce::simplified(&node_executable(app)).to_path_buf();
        eprintln!("[sidecar] launching {} {}", node.display(), entry.display());

        let mut child = Command::new(node)
            .arg(&entry)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Keep the console window hidden on Windows; this is a tray app.
            .spawn()
            .map_err(|e| format!("failed to start agent core ({}): {e}", entry.display()))?;

        let stdout = child.stdout.take().ok_or("core stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("core stderr unavailable")?;
        let stdin = child.stdin.take().ok_or("core stdin unavailable")?;

        *self.stdin.lock().unwrap() = Some(stdin);
        *self.child.lock().unwrap() = Some(child);

        // --- stdout: protocol frames ---------------------------------------
        let pending = Arc::clone(&self.pending);
        let handle = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<OutboundFrame>(&line) {
                    Ok(OutboundFrame::Event { event }) => {
                        let _ = handle.emit(UI_EVENT_CHANNEL, event);
                    }
                    Ok(OutboundFrame::Response { id, payload }) => {
                        if let Some(tx) = pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(payload);
                        }
                    }
                    Err(err) => {
                        eprintln!("[sidecar] undecodable frame: {err} :: {line}");
                    }
                }
            }
            // stdout closed: the core has exited.
            let _ = handle.emit(
                UI_CORE_STATUS_CHANNEL,
                json!({ "status": "stopped", "detail": "The agent core exited." }),
            );
        });

        // --- stderr: diagnostics -------------------------------------------
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[core] {line}");
            }
        });

        Ok(())
    }

    /// Send a request and block until the matching response arrives.
    pub fn request(&self, method: String, params: Value) -> Result<Value, String> {
        let id = format!("req_{}", self.counter.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);

        let frame = json!({ "kind": "request", "id": id, "method": method, "params": params });
        {
            let mut guard = self.stdin.lock().unwrap();
            let stdin = guard.as_mut().ok_or("agent core is not running")?;
            writeln!(stdin, "{frame}").map_err(|e| format!("failed to write to core: {e}"))?;
            stdin.flush().map_err(|e| format!("failed to flush to core: {e}"))?;
        }

        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(payload) => Ok(payload),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("the agent core did not answer \"{method}\" in time"))
            }
        }
    }

    /// Ask the core to shut down, then make sure it is gone.
    pub fn stop(&self) {
        let _ = self.request("agent.shutdown".into(), json!({}));
        std::thread::sleep(Duration::from_millis(150));
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Default for Sidecar {
    fn default() -> Self {
        Self::new()
    }
}

/// Locate the compiled core entrypoint.
///
/// In development the workspace layout is authoritative. In a bundled build the
/// core ships as a resource. Both are checked so `tauri dev` and a packaged
/// install behave identically.
fn resolve_core_entry(app: &AppHandle) -> Result<PathBuf, String> {
    // Development: the workspace layout is authoritative — a resource copy
    // staged next to the exe (see `bundle.resources` in tauri.conf.json) may
    // also exist during `cargo run`, but it lacks `node_modules`, so prefer
    // the live workspace build, which resolves dependencies via pnpm's
    // workspace symlinks.
    let mut cursor = std::env::current_dir().map_err(|e| e.to_string())?;
    loop {
        let candidate = cursor.join("packages/core/dist/main.js");
        if candidate.is_file() {
            return Ok(candidate);
        }
        if !cursor.pop() {
            break;
        }
    }

    // Packaged build: the core ships as a bundled resource next to the exe.
    if let Ok(resource) = app.path().resolve("core/main.js", tauri::path::BaseDirectory::Resource) {
        if resource.is_file() {
            return Ok(resource);
        }
    }

    Err("could not find the agent core. Run `pnpm build:packages` first.".into())
}

/// Node executable to run the core with.
///
/// Development uses whatever `node` is on PATH. A packaged build prefers a
/// bundled runtime so the user is not required to have Node installed.
fn node_executable(app: &AppHandle) -> PathBuf {
    if let Ok(bundled) = app
        .path()
        .resolve("node/node.exe", tauri::path::BaseDirectory::Resource)
    {
        if bundled.exists() {
            return bundled;
        }
    }
    PathBuf::from("node")
}
