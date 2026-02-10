mod claude_adapter;
mod codex_adapter;
mod commands;
mod state;
mod storage;
mod types;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let rt = tokio::runtime::Handle::current();
            let data = rt.block_on(storage::load_data());
            app.manage(AppState::new(data));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::add_project,
            commands::remove_project,
            commands::rename_project,
            commands::list_sessions,
            commands::create_session,
            commands::remove_session,
            commands::rename_session,
            commands::get_messages,
            commands::send_message,
            commands::get_settings,
            commands::update_settings,
            commands::check_cli_available,
            commands::stop_session,
            commands::get_all_sessions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
