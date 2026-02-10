use std::collections::HashMap;
use std::sync::Arc;
use tokio::process::Child;
use tokio::sync::Mutex;

use crate::types::{AppData, AppSettings};

/// Represents an active provider process for a session
pub struct ActiveSession {
    pub child: Option<Child>,
    pub session_id: String,
    /// Codex app-server thread id (required by turn/start)
    pub codex_thread_id: Option<String>,
}

/// Global application state managed by Tauri
pub struct AppState {
    pub data: Mutex<AppData>,
    pub settings: Mutex<AppSettings>,
    /// Active child processes keyed by session_id
    pub active_sessions: Mutex<HashMap<String, Arc<Mutex<ActiveSession>>>>,
}

impl AppState {
    pub fn new(data: AppData) -> Self {
        let settings = data.settings.clone();
        Self {
            data: Mutex::new(data),
            settings: Mutex::new(settings),
            active_sessions: Mutex::new(HashMap::new()),
        }
    }
}
