// Hide the console window on Windows release builds. The agent is a tray
// application; a stray console window would be both ugly and confusing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    samix_agent_lib::run()
}
