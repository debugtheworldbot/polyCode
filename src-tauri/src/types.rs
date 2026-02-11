use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AIProvider {
    Codex,
    Claude,
    Gemini,
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
    #[serde(default)]
    pub model: Option<String>,
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
    #[serde(default = "default_claude_permission_mode")]
    pub claude_permission_mode: String,
    pub theme: String,
    pub language: String,
    #[serde(default = "default_window_transparency")]
    pub window_transparency: u8,
}

fn default_claude_permission_mode() -> String {
    "acceptEdits".to_string()
}

fn default_window_transparency() -> u8 {
    80
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFileStatus {
    pub path: String,
    pub old_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatusResponse {
    pub is_git_repo: bool,
    pub branch: Option<String>,
    pub ahead: i32,
    pub behind: i32,
    pub files: Vec<GitFileStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFileDiffResponse {
    pub staged_patch: Option<String>,
    pub unstaged_patch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashCommand {
    pub command: String,
    pub description: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            codex_bin: None,
            claude_bin: None,
            claude_permission_mode: default_claude_permission_mode(),
            theme: "light".to_string(),
            language: "system".to_string(),
            window_transparency: default_window_transparency(),
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
