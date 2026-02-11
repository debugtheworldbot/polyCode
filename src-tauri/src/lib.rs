mod claude_adapter;
mod codex_adapter;
mod gemini_adapter;
mod commands;
mod state;
mod storage;
mod types;

use state::AppState;
use tauri::Manager;

#[cfg(target_os = "macos")]
pub(crate) fn apply_liquid_glass_effect(app: &tauri::AppHandle, transparency: u8) {
    use tauri_plugin_liquid_glass::{GlassMaterialVariant, LiquidGlassConfig, LiquidGlassExt};

    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let clamped = transparency.min(100);
    let alpha = (((100 - clamped) as f32 / 100.0) * 44.0 + 10.0).round() as u8;
    let tint = format!("#FFFFFF{:02X}", alpha);
    let config = LiquidGlassConfig {
        enabled: true,
        corner_radius: 10.0,
        tint_color: Some(tint),
        variant: GlassMaterialVariant::Regular,
    };

    if app.liquid_glass().set_effect(&window, config).is_err() {
        use tauri::window::Effect;
        let _ = window.set_effects(tauri::utils::config::WindowEffectsConfig {
            effects: vec![Effect::UnderWindowBackground],
            state: None,
            radius: None,
            color: None,
        });
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn apply_liquid_glass_effect(_app: &tauri::AppHandle, _transparency: u8) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_liquid_glass::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let data = tauri::async_runtime::block_on(storage::load_data());
            let initial_transparency = data.settings.window_transparency;
            app.manage(AppState::new(data));
            apply_liquid_glass_effect(&app.handle(), initial_transparency);

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
            commands::list_codex_slash_commands,
            commands::get_git_status,
            commands::get_git_file_diff,
            commands::git_stage_file,
            commands::git_unstage_file,
            commands::git_discard_file,
            commands::stop_session,
            commands::get_all_sessions,
            commands::save_provider_session_id,
            commands::save_pasted_image,
            commands::read_image_data_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
