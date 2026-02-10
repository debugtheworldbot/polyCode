mod claude_adapter;
mod codex_adapter;
mod gemini_adapter;
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
            let data = tauri::async_runtime::block_on(storage::load_data());
            app.manage(AppState::new(data));

            // Apply macOS vibrancy effect
            #[cfg(target_os = "macos")]
            {
                use tauri::window::Effect;
                let window = app.get_webview_window("main").unwrap();
                let _ = window.set_effects(tauri::utils::config::WindowEffectsConfig {
                    effects: vec![Effect::UnderWindowBackground],
                    state: None,
                    radius: None,
                    color: None,
                });
            }

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
            commands::update_session_model,
            commands::get_messages,
            commands::send_message,
            commands::get_settings,
            commands::update_settings,
            commands::check_cli_available,
            commands::stop_session,
            commands::get_all_sessions,
            commands::save_provider_session_id,
            commands::save_pasted_image,
            commands::read_image_data_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
