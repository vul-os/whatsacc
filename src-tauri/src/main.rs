// whatsacc desktop shell — a thin Tauri v2 wrapper around the portal SPA.
// All application logic lives in the web frontend; the shell only provides
// the window and the CORS-free HTTP plugin used to reach arbitrary gateways.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("error while running whatsacc");
}
