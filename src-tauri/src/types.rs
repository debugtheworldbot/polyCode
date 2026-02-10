use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AIProvider {
    Codex,
    Claude,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub provider: AIProvider,
    pub created_at: i64,
    pub updated_at: i64,
    /// For Claude Code, stores the CLI session_id for --resume
    pub provider_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageType {
    Text,
    Tool,
    Diff,
    Error,
    Reasoning,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub session_id: String,
    pub role: MessageRole,
    pub content: String,
    pub message_type: MessageType,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub codex_bin: Option<String>,
    pub claude_bin: Option<String>,
    pub theme: String,
    pub language: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            codex_bin: None,
            claude_bin: None,
            theme: "light".to_string(),
            language: "system".to_string(),
        }
    }
}

/// Event emitted to the frontend when a session produces output
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEvent {
    pub session_id: String,
    pub event_type: String,
    pub data: serde_json::Value,
}

/// Persistent data stored to disk
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppData {
    pub projects: Vec<Project>,
    pub sessions: Vec<Session>,
    pub settings: AppSettings,
}
