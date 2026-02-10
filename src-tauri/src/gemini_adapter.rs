use std::path::PathBuf;
use tokio::fs;
use sha2::{Sha256, Digest};
use chrono::DateTime;
use crate::types::{ChatMessage, MessageRole, MessageType};

#[derive(serde::Deserialize)]
struct GeminiSession {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "lastUpdated")]
    last_updated: String,
    messages: Vec<GeminiMessage>,
}

#[derive(serde::Deserialize)]
struct GeminiMessage {
    id: String,
    timestamp: String,
    #[serde(rename = "type")]
    msg_type: String,
    content: String,
}

pub fn get_project_hash(path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn get_gemini_dir(project_path: &str) -> PathBuf {
    let hash = get_project_hash(project_path);
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".gemini/tmp")
        .join(hash)
        .join("chats")
}

pub async fn list_gemini_sessions(project_path: &str) -> Vec<PathBuf> {
    let dir = get_gemini_dir(project_path);
    let mut files = vec![];
    if let Ok(mut entries) = fs::read_dir(dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                files.push(path);
            }
        }
    }
    files
}

pub async fn read_gemini_session(path: &PathBuf) -> Result<(String, i64, Vec<ChatMessage>), String> {
    let content = fs::read_to_string(path).await.map_err(|e| e.to_string())?;
    let session: GeminiSession = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    
    let updated_at = DateTime::parse_from_rfc3339(&session.last_updated)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis());

    let messages = session.messages.into_iter().map(|msg| {
        let created_at = DateTime::parse_from_rfc3339(&msg.timestamp)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis());

        let (role, message_type) = match msg.msg_type.as_str() {
            "user" => (MessageRole::User, MessageType::Text),
            "model" => (MessageRole::Assistant, MessageType::Text),
            "tool" => (MessageRole::Assistant, MessageType::Tool),
            "system" => (MessageRole::System, MessageType::Text),
            _ => (MessageRole::Assistant, MessageType::Text),
        };

        ChatMessage {
            id: msg.id,
            session_id: session.session_id.clone(),
            role,
            content: msg.content,
            message_type,
            created_at,
        }
    }).collect();

    Ok((session.session_id, updated_at, messages))
}
