use std::path::PathBuf;
use tokio::fs;

use crate::types::AppData;

fn data_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("codex-hub")
}

fn data_file() -> PathBuf {
    data_dir().join("data.json")
}

pub async fn load_data() -> AppData {
    let path = data_file();
    if path.exists() {
        match fs::read_to_string(&path).await {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(_) => AppData::default(),
        }
    } else {
        AppData::default()
    }
}

pub async fn save_data(data: &AppData) -> Result<(), String> {
    let dir = data_dir();
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create data dir: {}", e))?;

    let content =
        serde_json::to_string_pretty(data).map_err(|e| format!("Failed to serialize: {}", e))?;

    fs::write(data_file(), content)
        .await
        .map_err(|e| format!("Failed to write data: {}", e))?;

    Ok(())
}

/// Get the path for session messages
fn messages_dir() -> PathBuf {
    data_dir().join("messages")
}

pub async fn load_messages(session_id: &str) -> Vec<crate::types::ChatMessage> {
    let path = messages_dir().join(format!("{}.json", session_id));
    if path.exists() {
        match fs::read_to_string(&path).await {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(_) => vec![],
        }
    } else {
        vec![]
    }
}

pub async fn save_messages(
    session_id: &str,
    messages: &[crate::types::ChatMessage],
) -> Result<(), String> {
    let dir = messages_dir();
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create messages dir: {}", e))?;

    let content = serde_json::to_string_pretty(messages)
        .map_err(|e| format!("Failed to serialize messages: {}", e))?;

    fs::write(dir.join(format!("{}.json", session_id)), content)
        .await
        .map_err(|e| format!("Failed to write messages: {}", e))?;

    Ok(())
}
