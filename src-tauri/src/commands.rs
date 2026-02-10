use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::claude_adapter;
use crate::codex_adapter;
use crate::gemini_adapter;
use crate::state::{ActiveSession, AppState};
use crate::storage;
use crate::types::*;

// ─── Project Commands ───

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>, String> {
    let (projects_snapshot, codex_bin) = {
        let data = state.data.lock().await;
        (data.projects.clone(), data.settings.codex_bin.clone())
    };

    for project in &projects_snapshot {
        if let Err(e) = sync_codex_sessions_for_project(
            &project.id,
            &project.path,
            &codex_bin,
            &state,
        )
        .await
        {
            eprintln!(
                "Failed to sync Codex sessions for project {} while listing projects: {}",
                project.id, e
            );
        }
    }

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
    let (project_path, codex_bin) = {
        let data = state.data.lock().await;
        let project = data
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .cloned()
            .ok_or("Project not found")?;
        (project.path, data.settings.codex_bin.clone())
    };

    if let Err(e) = sync_codex_sessions_for_project(&project_id, &project_path, &codex_bin, &state).await {
        eprintln!("Failed to sync Codex sessions for project {}: {}", project_id, e);
    }

    if let Err(e) = sync_claude_sessions_for_project(&project_id, &project_path, &state).await {
        eprintln!("Failed to sync Claude sessions for project {}: {}", project_id, e);
    }

    if let Err(e) = sync_gemini_sessions_for_project(&project_id, &project_path, &state).await {
        eprintln!("Failed to sync Gemini sessions for project {}: {}", project_id, e);
    }

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
        "gemini" => AIProvider::Gemini,
        _ => return Err(format!("Unknown provider: {}", provider)),
    };

    let now = chrono::Utc::now().timestamp_millis();
    let session_name = name.unwrap_or_else(|| {
        let prefix = match ai_provider {
            AIProvider::Codex => "Codex",
            AIProvider::Claude => "Claude",
            AIProvider::Gemini => "Gemini",
        };
        format!("{} Session", prefix)
    });

    let session = Session {
        id: uuid::Uuid::new_v4().to_string(),
        project_id,
        name: session_name,
        provider: ai_provider,
        model: None,
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

#[tauri::command]
pub async fn update_session_model(
    session_id: String,
    model: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let normalized_model = model.and_then(|m| {
        let trimmed = m.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });

    let mut data = state.data.lock().await;
    let session = data
        .sessions
        .iter_mut()
        .find(|s| s.id == session_id)
        .ok_or("Session not found")?;
    session.model = normalized_model;
    session.updated_at = chrono::Utc::now().timestamp_millis();
    storage::save_data(&data).await?;

    Ok(())
}

// ─── Message Commands ───

#[tauri::command]
pub async fn get_messages(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ChatMessage>, String> {
    let local_messages = storage::load_messages(&session_id).await;

    let (session, project, codex_bin) = {
        let data = state.data.lock().await;
        let session = data
            .sessions
            .iter()
            .find(|s| s.id == session_id)
            .cloned()
            .ok_or("Session not found")?;
        let project = data
            .projects
            .iter()
            .find(|p| p.id == session.project_id)
            .cloned()
            .ok_or("Project not found")?;
        (session, project, data.settings.codex_bin.clone())
    };

    if session.provider == AIProvider::Claude {
        let Some(ref claude_sid) = session.provider_session_id else {
            return Ok(local_messages);
        };

        let imported = match claude_adapter::read_claude_session_messages(
            &project.path,
            claude_sid,
            &session_id,
        )
        .await
        {
            Ok(msgs) => msgs,
            Err(e) => {
                eprintln!(
                    "Failed to import Claude messages for session {} (falling back to local cache): {}",
                    session_id, e
                );
                return Ok(local_messages);
            }
        };

        if imported.is_empty() {
            return Ok(local_messages);
        }

        if should_refresh_cached_messages(&local_messages, &imported) {
            storage::save_messages(&session_id, &imported).await?;
            return Ok(imported);
        }

        return Ok(local_messages);
    }

    if session.provider != AIProvider::Codex {
        return Ok(local_messages);
    }

    let Some(thread_id) = session.provider_session_id else {
        return Ok(local_messages);
    };

    let imported_messages = match codex_adapter::read_codex_thread_messages(
        project.path.clone(),
        codex_bin,
        thread_id,
        session_id.clone(),
    )
    .await
    {
        Ok(messages) => messages,
        Err(e) => {
            eprintln!(
                "Failed to import Codex messages for session {} (falling back to local cache): {}",
                session_id, e
            );
            return Ok(local_messages);
        }
    };

    if imported_messages.is_empty() {
        return Ok(local_messages);
    }

    if should_refresh_cached_messages(&local_messages, &imported_messages) {
        storage::save_messages(&session_id, &imported_messages).await?;
        return Ok(imported_messages);
    }

    Ok(local_messages)
}

#[tauri::command]
pub async fn send_message(
    session_id: String,
    content: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ChatMessage, String> {
    let (text_content, local_image_paths) = extract_local_images_from_content(&content);
    let display_content = build_display_content(&text_content, &local_image_paths);
    if display_content.trim().is_empty() {
        return Err("Message is empty".to_string());
    }

    // Create user message
    let user_msg = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.clone(),
        role: MessageRole::User,
        content: display_content.clone(),
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
                &text_content,
                &local_image_paths,
                &project.path,
                &settings.codex_bin,
                session.model.as_deref(),
                session.provider_session_id.as_deref(),
                &state,
                &app,
            )
            .await?;
        }
        AIProvider::Claude => {
            send_claude_message_impl(
                &session_id,
                &display_content,
                &project.path,
                &settings.claude_bin,
                session.model.as_deref(),
                session.provider_session_id.as_deref(),
                &state,
                &app,
            )
            .await?;
        }
        AIProvider::Gemini => {
            return Err("Gemini provider is not supported yet".to_string());
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
    text_content: &str,
    local_image_paths: &[String],
    project_path: &str,
    codex_bin: &Option<String>,
    model: Option<&str>,
    provider_session_id: Option<&str>,
    state: &State<'_, AppState>,
    app: &AppHandle,
) -> Result<(), String> {
    let mut active = state.active_sessions.lock().await;
    let mut started_thread_id: Option<String> = None;

    if !active.contains_key(session_id) {
        // Spawn new codex app-server
        let (child, codex_thread_id) = codex_adapter::spawn_codex_session(
            session_id.to_string(),
            project_path.to_string(),
            codex_bin.clone(),
            model.map(|m| m.to_string()),
            provider_session_id.map(|s| s.to_string()),
            app.clone(),
        )
        .await?;

        active.insert(
            session_id.to_string(),
            Arc::new(Mutex::new(ActiveSession {
                child: Some(child),
                codex_thread_id: Some(codex_thread_id.clone()),
            })),
        );
        started_thread_id = Some(codex_thread_id);

        // Wait a bit for initialization
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }

    let session_arc = active.get(session_id).cloned();
    drop(active);

    if let Some(thread_id) = started_thread_id {
        if !thread_id.is_empty() {
            let mut data = state.data.lock().await;
            if let Some(session) = data.sessions.iter_mut().find(|s| s.id == session_id) {
                if session.provider == AIProvider::Codex && session.provider_session_id.is_none() {
                    session.provider_session_id = Some(thread_id);
                    storage::save_data(&data).await?;
                }
            }
        }
    }

    if let Some(session_arc) = session_arc {
        let mut session = session_arc.lock().await;
        let thread_id = session
            .codex_thread_id
            .clone()
            .ok_or("Missing Codex thread id for active session")?;

        if let Some(ref mut child) = session.child {
            if let Some(ref mut stdin) = child.stdin {
                let mut input_items: Vec<Value> = Vec::new();
                if !text_content.trim().is_empty() {
                    input_items.push(json!({
                        "type": "text",
                        "text": text_content,
                    }));
                }
                for path in local_image_paths {
                    let trimmed = path.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    input_items.push(json!({
                        "type": "localImage",
                        "path": trimmed,
                    }));
                }
                if input_items.is_empty() {
                    return Err("Message is empty".to_string());
                }

                let mut turn_params = json!({
                    "threadId": thread_id,
                    "input": input_items,
                });

                if let Some(model_name) = model.and_then(|m| {
                    let trimmed = m.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed.to_string())
                    }
                }) {
                    if let Some(obj) = turn_params.as_object_mut() {
                        obj.insert("model".to_string(), Value::String(model_name));
                    }
                }

                codex_adapter::send_codex_message(
                    stdin,
                    "turn/start",
                    turn_params,
                )
                .await?;
            }
        }
    }

    Ok(())
}

fn extract_local_images_from_content(content: &str) -> (String, Vec<String>) {
    let mut text_lines: Vec<&str> = Vec::new();
    let mut local_images: Vec<String> = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(path) = extract_local_image_path(trimmed) {
            local_images.push(path);
        } else {
            text_lines.push(line);
        }
    }

    let text_content = text_lines.join("\n").trim().to_string();
    let mut dedup = HashSet::new();
    let deduped_images = local_images
        .into_iter()
        .filter(|path| dedup.insert(path.clone()))
        .collect();

    (text_content, deduped_images)
}

fn extract_local_image_path(line: &str) -> Option<String> {
    if !(line.starts_with("[Image:") && line.ends_with(']')) {
        return None;
    }
    let path = line
        .trim_start_matches("[Image:")
        .trim_end_matches(']')
        .trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

fn build_display_content(text: &str, local_images: &[String]) -> String {
    let image_lines = local_images
        .iter()
        .map(|path| format!("[Image: {}]", path))
        .collect::<Vec<_>>()
        .join("\n");

    if text.is_empty() {
        image_lines
    } else if image_lines.is_empty() {
        text.to_string()
    } else {
        format!("{}\n\n{}", text, image_lines)
    }
}

async fn send_claude_message_impl(
    session_id: &str,
    content: &str,
    project_path: &str,
    claude_bin: &Option<String>,
    model: Option<&str>,
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
        model.map(|m| m.to_string()),
        provider_session_id.map(|s| s.to_string()),
        app.clone(),
    )
    .await?;

    let mut active = state.active_sessions.lock().await;
    active.insert(
        session_id.to_string(),
        Arc::new(Mutex::new(ActiveSession {
            child: Some(child),
            codex_thread_id: None,
        })),
    );

    Ok(())
}

async fn sync_claude_sessions_for_project(
    project_id: &str,
    project_path: &str,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    let claude_sessions = claude_adapter::list_claude_sessions(project_path).await;

    let mut data = state.data.lock().await;
    let mut changed = false;

    for info in claude_sessions {
        if let Some(existing) = data.sessions.iter_mut().find(|s| {
            s.project_id == project_id
                && s.provider == AIProvider::Claude
                && s.provider_session_id.as_deref() == Some(info.session_id.as_str())
        }) {
            if existing.updated_at < info.updated_at_ms {
                existing.updated_at = info.updated_at_ms;
                changed = true;
            }

            if existing.name.trim().eq_ignore_ascii_case("Claude Session") && !info.preview.is_empty() {
                let candidate = derive_claude_session_name(&info.preview);
                if existing.name != candidate {
                    existing.name = candidate;
                    changed = true;
                }
            }

            continue;
        }

        let session_name = if info.preview.is_empty() {
            "Claude Session".to_string()
        } else {
            derive_claude_session_name(&info.preview)
        };

        data.sessions.push(Session {
            id: uuid::Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            name: session_name,
            provider: AIProvider::Claude,
            model: None,
            created_at: info.created_at_ms,
            updated_at: info.updated_at_ms,
            provider_session_id: Some(info.session_id),
        });
        changed = true;
    }

    if changed {
        let snapshot = data.clone();
        drop(data);
        storage::save_data(&snapshot).await?;
    }

    Ok(())
}

fn derive_claude_session_name(preview: &str) -> String {
    let first_line = preview
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Claude Session");

    let mut truncated: String = first_line.chars().take(60).collect();
    if first_line.chars().count() > 60 {
        truncated.push('…');
    }

    if truncated.trim().is_empty() {
        "Claude Session".to_string()
    } else {
        truncated
    }
}

async fn sync_codex_sessions_for_project(
    project_id: &str,
    project_path: &str,
    codex_bin: &Option<String>,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    let codex_threads =
        codex_adapter::list_codex_threads(project_path.to_string(), codex_bin.clone()).await?;

    let mut data = state.data.lock().await;
    let mut changed = false;

    for thread in codex_threads {
        if !is_same_project_path(&thread.cwd, project_path) {
            continue;
        }

        if let Some(existing) = data.sessions.iter_mut().find(|s| {
            s.project_id == project_id
                && s.provider == AIProvider::Codex
                && s.provider_session_id.as_deref() == Some(thread.thread_id.as_str())
        }) {
            let updated_at = thread.updated_at_secs.saturating_mul(1000);
            if existing.updated_at < updated_at {
                existing.updated_at = updated_at;
                changed = true;
            }

            if existing.name.trim().eq_ignore_ascii_case("Codex Session") {
                let candidate = derive_codex_session_name(&thread.preview);
                if existing.name != candidate {
                    existing.name = candidate;
                    changed = true;
                }
            }

            continue;
        }

        let now = chrono::Utc::now().timestamp_millis();
        let created_at = if thread.created_at_secs > 0 {
            thread.created_at_secs.saturating_mul(1000)
        } else {
            now
        };
        let updated_at = if thread.updated_at_secs > 0 {
            thread.updated_at_secs.saturating_mul(1000)
        } else {
            created_at
        };

        data.sessions.push(Session {
            id: uuid::Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            name: derive_codex_session_name(&thread.preview),
            provider: AIProvider::Codex,
            model: None,
            created_at,
            updated_at,
            provider_session_id: Some(thread.thread_id),
        });
        changed = true;
    }

    if changed {
        let snapshot = data.clone();
        drop(data);
        storage::save_data(&snapshot).await?;
    }

    Ok(())
}

fn derive_codex_session_name(preview: &str) -> String {
    let first_line = preview
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Codex Session");

    let mut truncated: String = first_line.chars().take(60).collect();
    if first_line.chars().count() > 60 {
        truncated.push('…');
    }

    if truncated.trim().is_empty() {
        "Codex Session".to_string()
    } else {
        truncated
    }
}

fn is_same_project_path(thread_cwd: &str, project_path: &str) -> bool {
    fn canonicalize_path(path: &str) -> Option<PathBuf> {
        if path.trim().is_empty() {
            return None;
        }
        std::fs::canonicalize(path).ok()
    }

    fn normalize_lossy(path: &str) -> String {
        path.replace('\\', "/").trim_end_matches('/').to_string()
    }

    let thread_canon = canonicalize_path(thread_cwd);
    let project_canon = canonicalize_path(project_path);
    if let (Some(thread), Some(project)) = (thread_canon, project_canon) {
        return thread == project || thread.starts_with(&project);
    }

    let thread = normalize_lossy(thread_cwd);
    let project = normalize_lossy(project_path);
    if thread.is_empty() || project.is_empty() {
        return false;
    }

    if thread == project {
        return true;
    }

    Path::new(&thread).starts_with(Path::new(&project))
}

fn should_refresh_cached_messages(local: &[ChatMessage], remote: &[ChatMessage]) -> bool {
    if local.is_empty() {
        return true;
    }

    if local.len() != remote.len() {
        return true;
    }

    for (cached, latest) in local.iter().zip(remote.iter()) {
        if std::mem::discriminant(&cached.role) != std::mem::discriminant(&latest.role) {
            return true;
        }

        if std::mem::discriminant(&cached.message_type)
            != std::mem::discriminant(&latest.message_type)
        {
            return true;
        }

        if cached.content.trim() != latest.content.trim() {
            return true;
        }
    }

    false
}

#[tauri::command]
pub async fn save_provider_session_id(
    session_id: String,
    provider_session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut data = state.data.lock().await;
    if let Some(session) = data.sessions.iter_mut().find(|s| s.id == session_id) {
        if session.provider_session_id.is_none() {
            session.provider_session_id = Some(provider_session_id);
            storage::save_data(&data).await?;
        }
    }
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
pub async fn save_pasted_image(data_url: String, app: AppHandle) -> Result<String, String> {
    let (header, encoded) = data_url
        .split_once(',')
        .ok_or("Invalid image data URL")?;
    if !header.starts_with("data:image/") || !header.ends_with(";base64") {
        return Err("Only base64 image data URLs are supported".to_string());
    }

    let mime = header
        .trim_start_matches("data:")
        .trim_end_matches(";base64");
    let extension = image_extension_for_mime(mime);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| format!("Failed to decode image data: {}", e))?;

    let dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("codex-hub-cache"))
        .join("images");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create image cache dir: {}", e))?;

    let filename = format!("paste-{}.{}", uuid::Uuid::new_v4(), extension);
    let path = dir.join(filename);
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("Failed to save pasted image: {}", e))?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn read_image_data_url(path: String) -> Result<String, String> {
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Failed to read image file: {}", e))?;
    let mime = image_mime_for_path(&path);
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

fn image_mime_for_path(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());

    match ext.as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn image_extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        _ => "png",
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

async fn sync_gemini_sessions_for_project(
    project_id: &str,
    project_path: &str,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    let gemini_sessions = gemini_adapter::list_gemini_sessions(project_path).await;

    let mut data = state.data.lock().await;
    let mut changed = false;

    for session_path in gemini_sessions {
        // Read session from file
        let (gemini_session_id, updated_at, messages) = match gemini_adapter::read_gemini_session(&session_path).await {
            Ok(res) => res,
            Err(e) => {
                eprintln!("Failed to read Gemini session {:?}: {}", session_path, e);
                continue;
            }
        };

        // Check if session already exists
        if let Some(existing_idx) = data.sessions.iter().position(|s| {
            s.project_id == project_id
                && s.provider == AIProvider::Gemini
                && s.provider_session_id.as_deref() == Some(gemini_session_id.as_str())
        }) {
            let mut should_sync_messages = false;
            let existing_session_id;
            {
                let existing = &mut data.sessions[existing_idx];
                existing_session_id = existing.id.clone();
                if existing.updated_at < updated_at {
                    existing.updated_at = updated_at;
                    changed = true;
                    should_sync_messages = true;
                }
            }

            if should_sync_messages {
                drop(data); // Unlock to save messages
                storage::save_messages(&existing_session_id, &messages).await?;
                data = state.data.lock().await; // Re-lock
            }
            continue;
        }

        // Create new session
        let new_session_id = uuid::Uuid::new_v4().to_string();
        let created_at = messages.first().map(|m| m.created_at).unwrap_or(updated_at);
        
        let session_name = messages
            .first()
            .map(|m| {
                let text = m.content.lines().next().unwrap_or("Gemini Session");
                let mut truncated: String = text.chars().take(60).collect();
                if text.chars().count() > 60 {
                    truncated.push('…');
                }
                truncated
            })
            .unwrap_or_else(|| "Gemini Session".to_string());

        let new_session = Session {
            id: new_session_id.clone(),
            project_id: project_id.to_string(),
            name: session_name,
            provider: AIProvider::Gemini,
            created_at,
            updated_at,
            provider_session_id: Some(gemini_session_id),
            model: None, 
        };

        drop(data); // Unlock to save messages
        storage::save_messages(&new_session_id, &messages).await?;
        data = state.data.lock().await; // Re-lock
        
        data.sessions.push(new_session);
        changed = true;
    }

    if changed {
        let snapshot = data.clone();
        drop(data);
        storage::save_data(&snapshot).await?;
    }

    Ok(())
}
