use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::claude_adapter;
use crate::codex_adapter;
use crate::state::{ActiveSession, AppState};
use crate::storage;
use crate::types::*;

// ─── Project Commands ───

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>, String> {
    let data = state.data.lock().await;
    Ok(data.projects.clone())
}

#[tauri::command]
pub async fn add_project(
    name: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let mut data = state.data.lock().await;

    // Check if project with same path already exists
    if data.projects.iter().any(|p| p.path == path) {
        return Err("A project with this path already exists".to_string());
    }

    let project = Project {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        path,
        created_at: chrono::Utc::now().timestamp_millis(),
    };

    data.projects.push(project.clone());
    storage::save_data(&data).await?;

    Ok(project)
}

#[tauri::command]
pub async fn remove_project(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut data = state.data.lock().await;
    data.projects.retain(|p| p.id != project_id);
    // Also remove sessions for this project
    data.sessions.retain(|s| s.project_id != project_id);
    storage::save_data(&data).await?;
    Ok(())
}

#[tauri::command]
pub async fn rename_project(
    project_id: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut data = state.data.lock().await;
    if let Some(project) = data.projects.iter_mut().find(|p| p.id == project_id) {
        project.name = new_name;
    }
    storage::save_data(&data).await?;
    Ok(())
}

// ─── Session Commands ───

#[tauri::command]
pub async fn list_sessions(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<Session>, String> {
    let data = state.data.lock().await;
    let sessions: Vec<Session> = data
        .sessions
        .iter()
        .filter(|s| s.project_id == project_id)
        .cloned()
        .collect();
    Ok(sessions)
}

#[tauri::command]
pub async fn create_session(
    project_id: String,
    provider: String,
    name: Option<String>,
    state: State<'_, AppState>,
) -> Result<Session, String> {
    let ai_provider = match provider.as_str() {
        "codex" => AIProvider::Codex,
        "claude" => AIProvider::Claude,
        _ => return Err(format!("Unknown provider: {}", provider)),
    };

    let now = chrono::Utc::now().timestamp_millis();
    let session_name = name.unwrap_or_else(|| {
        let prefix = match ai_provider {
            AIProvider::Codex => "Codex",
            AIProvider::Claude => "Claude",
        };
        format!("{} Session", prefix)
    });

    let session = Session {
        id: uuid::Uuid::new_v4().to_string(),
        project_id,
        name: session_name,
        provider: ai_provider,
        created_at: now,
        updated_at: now,
        provider_session_id: None,
    };

    let mut data = state.data.lock().await;
    data.sessions.push(session.clone());
    storage::save_data(&data).await?;

    Ok(session)
}

#[tauri::command]
pub async fn remove_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Kill active process if any
    let mut active = state.active_sessions.lock().await;
    if let Some(session) = active.remove(&session_id) {
        let mut s = session.lock().await;
        if let Some(ref mut child) = s.child {
            let _ = child.kill().await;
        }
    }
    drop(active);

    let mut data = state.data.lock().await;
    data.sessions.retain(|s| s.id != session_id);
    storage::save_data(&data).await?;
    Ok(())
}

#[tauri::command]
pub async fn rename_session(
    session_id: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut data = state.data.lock().await;
    if let Some(session) = data.sessions.iter_mut().find(|s| s.id == session_id) {
        session.name = new_name;
    }
    storage::save_data(&data).await?;
    Ok(())
}

// ─── Message Commands ───

#[tauri::command]
pub async fn get_messages(session_id: String) -> Result<Vec<ChatMessage>, String> {
    let messages = storage::load_messages(&session_id).await;
    Ok(messages)
}

#[tauri::command]
pub async fn send_message(
    session_id: String,
    content: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ChatMessage, String> {
    // Create user message
    let user_msg = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.clone(),
        role: MessageRole::User,
        content: content.clone(),
        message_type: MessageType::Text,
        created_at: chrono::Utc::now().timestamp_millis(),
    };

    // Save user message
    let mut messages = storage::load_messages(&session_id).await;
    messages.push(user_msg.clone());
    storage::save_messages(&session_id, &messages).await?;

    // Emit user message event
    let _ = app.emit(
        "session-event",
        SessionEvent {
            session_id: session_id.clone(),
            event_type: "user_message".to_string(),
            data: serde_json::to_value(&user_msg).unwrap(),
        },
    );

    // Find the session info
    let data = state.data.lock().await;
    let session = data
        .sessions
        .iter()
        .find(|s| s.id == session_id)
        .ok_or("Session not found")?
        .clone();
    let project = data
        .projects
        .iter()
        .find(|p| p.id == session.project_id)
        .ok_or("Project not found")?
        .clone();
    let settings = data.settings.clone();
    drop(data);

    match session.provider {
        AIProvider::Codex => {
            send_codex_message_impl(
                &session_id,
                &content,
                &project.path,
                &settings.codex_bin,
                &state,
                &app,
            )
            .await?;
        }
        AIProvider::Claude => {
            send_claude_message_impl(
                &session_id,
                &content,
                &project.path,
                &settings.claude_bin,
                session.provider_session_id.as_deref(),
                &state,
                &app,
            )
            .await?;
        }
    }

    // Update session timestamp
    let mut data = state.data.lock().await;
    if let Some(s) = data.sessions.iter_mut().find(|s| s.id == session_id) {
        s.updated_at = chrono::Utc::now().timestamp_millis();
    }
    storage::save_data(&data).await?;

    Ok(user_msg)
}

async fn send_codex_message_impl(
    session_id: &str,
    content: &str,
    project_path: &str,
    codex_bin: &Option<String>,
    state: &State<'_, AppState>,
    app: &AppHandle,
) -> Result<(), String> {
    let mut active = state.active_sessions.lock().await;

    if !active.contains_key(session_id) {
        // Spawn new codex app-server
        let (child, codex_thread_id) = codex_adapter::spawn_codex_session(
            session_id.to_string(),
            project_path.to_string(),
            codex_bin.clone(),
            app.clone(),
        )
        .await?;

        active.insert(
            session_id.to_string(),
            Arc::new(Mutex::new(ActiveSession {
                child: Some(child),
                session_id: session_id.to_string(),
                codex_thread_id: Some(codex_thread_id),
            })),
        );

        // Wait a bit for initialization
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }

    let session_arc = active.get(session_id).cloned();
    drop(active);

    if let Some(session_arc) = session_arc {
        let mut session = session_arc.lock().await;
        let thread_id = session
            .codex_thread_id
            .clone()
            .ok_or("Missing Codex thread id for active session")?;

        if let Some(ref mut child) = session.child {
            if let Some(ref mut stdin) = child.stdin {
                codex_adapter::send_codex_message(
                    stdin,
                    "turn/start",
                    json!({
                        "threadId": thread_id,
                        "input": [
                            {
                                "type": "text",
                                "text": content,
                            }
                        ],
                    }),
                )
                .await?;
            }
        }
    }

    Ok(())
}

async fn send_claude_message_impl(
    session_id: &str,
    content: &str,
    project_path: &str,
    claude_bin: &Option<String>,
    provider_session_id: Option<&str>,
    state: &State<'_, AppState>,
    app: &AppHandle,
) -> Result<(), String> {
    // For Claude Code, each message spawns a new process
    // (Claude CLI is not a persistent server like Codex app-server)
    let child = claude_adapter::spawn_claude_session(
        session_id.to_string(),
        project_path.to_string(),
        content.to_string(),
        claude_bin.clone(),
        provider_session_id.map(|s| s.to_string()),
        app.clone(),
    )
    .await?;

    let mut active = state.active_sessions.lock().await;
    active.insert(
        session_id.to_string(),
        Arc::new(Mutex::new(ActiveSession {
            child: Some(child),
            session_id: session_id.to_string(),
            codex_thread_id: None,
        })),
    );

    Ok(())
}

// ─── Settings Commands ───

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let data = state.data.lock().await;
    Ok(data.settings.clone())
}

#[tauri::command]
pub async fn update_settings(
    settings: AppSettings,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut data = state.data.lock().await;
    data.settings = settings.clone();
    storage::save_data(&data).await?;

    let mut s = state.settings.lock().await;
    *s = settings;

    Ok(())
}

// ─── Utility Commands ───

#[tauri::command]
pub async fn check_cli_available(cli_name: String) -> Result<Value, String> {
    let output = tokio::process::Command::new("which")
        .arg(&cli_name)
        .output()
        .await;

    match output {
        Ok(out) => {
            let available = out.status.success();
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Ok(json!({
                "available": available,
                "path": if available { Some(path) } else { None },
            }))
        }
        Err(_) => Ok(json!({
            "available": false,
            "path": null,
        })),
    }
}

#[tauri::command]
pub async fn stop_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut active = state.active_sessions.lock().await;
    if let Some(session) = active.remove(&session_id) {
        let mut s = session.lock().await;
        if let Some(ref mut child) = s.child {
            let _ = child.kill().await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn get_all_sessions(state: State<'_, AppState>) -> Result<Vec<Session>, String> {
    let data = state.data.lock().await;
    Ok(data.sessions.clone())
}
