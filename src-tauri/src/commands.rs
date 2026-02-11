use base64::Engine;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::Arc;
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
                &settings.claude_permission_mode,
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
    let slash_invocation = if local_image_paths.is_empty() {
        parse_codex_slash_invocation(text_content)
    } else {
        None
    };

    if let Some(invocation) = slash_invocation.as_ref() {
        if invocation.command == CODEX_STATUS_COMMAND {
            return handle_codex_status_command(
                session_id,
                project_path,
                codex_bin,
                model,
                provider_session_id,
                state,
                app,
            )
            .await;
        }

        if invocation.command == CODEX_USAGE_COMMAND {
            return handle_codex_status_command(
                session_id,
                project_path,
                codex_bin,
                model,
                provider_session_id,
                state,
                app,
            )
            .await;
        }

        if handle_codex_readonly_slash_command(
            invocation,
            session_id,
            project_path,
            codex_bin,
            app,
        )
        .await?
        {
            return Ok(());
        }
    }

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
                if let Some(invocation) = slash_invocation.as_ref() {
                    if handle_codex_thread_slash_command(
                        invocation,
                        session_id,
                        &thread_id,
                        model,
                        state,
                        app,
                        stdin,
                    )
                    .await?
                    {
                        return Ok(());
                    }

                    append_and_emit_assistant_message(
                        session_id,
                        format!(
                            "Slash command {} is not supported in this app yet.",
                            invocation.command
                        ),
                        app,
                    )
                    .await?;
                    emit_codex_turn_completed(session_id, app).await;
                    return Ok(());
                }

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

const CODEX_STATUS_COMMAND: &str = "/status";
const CODEX_USAGE_COMMAND: &str = "/usage";
const CODEX_COMPACT_COMMAND: &str = "/compact";
const CODEX_REVIEW_COMMAND: &str = "/review";
const CODEX_INIT_COMMAND: &str = "/init";
const CODEX_RENAME_COMMAND: &str = "/rename";
const CODEX_MODEL_COMMAND: &str = "/model";
const CODEX_MCP_COMMAND: &str = "/mcp";
const CODEX_SKILLS_COMMAND: &str = "/skills";
const CODEX_APPS_COMMAND: &str = "/apps";

const CODEX_INIT_PROMPT: &str = "Generate or update AGENTS.md for this repository. Keep it concise and practical. Include: project structure, build/test/dev commands, coding style, testing guidance, and commit/PR guidelines.";

#[derive(Debug, Clone)]
struct CodexSlashInvocation {
    command: String,
    args: String,
}

fn parse_codex_slash_invocation(input: &str) -> Option<CodexSlashInvocation> {
    let trimmed = input.trim();
    if !trimmed.starts_with('/') {
        return None;
    }

    let mut split_at = trimmed.len();
    for (idx, ch) in trimmed.char_indices() {
        if idx == 0 {
            continue;
        }
        if ch.is_whitespace() {
            split_at = idx;
            break;
        }
    }

    let command = trimmed[..split_at].to_ascii_lowercase();
    if command.len() <= 1 || !command[1..].chars().all(is_slash_command_char) {
        return None;
    }

    let args = if split_at < trimmed.len() {
        trimmed[split_at..].trim().to_string()
    } else {
        String::new()
    };

    Some(CodexSlashInvocation { command, args })
}

fn trim_to_option(value: Option<&str>) -> Option<String> {
    value.and_then(|v| {
        let trimmed = v.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn first_non_empty_string(value: &Value, keys: &[&str]) -> Option<String> {
    let obj = value.as_object()?;
    for key in keys {
        if let Some(text) = obj.get(*key).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn extract_codex_version_from_user_agent(user_agent: &str) -> Option<String> {
    let (_, remainder) = user_agent.split_once('/')?;
    let version = remainder.split_whitespace().next()?.trim();
    if version.is_empty() {
        None
    } else {
        Some(version.to_string())
    }
}

async fn active_codex_thread_id_for_session(
    session_id: &str,
    state: &State<'_, AppState>,
) -> Option<String> {
    let session_arc = {
        let active = state.active_sessions.lock().await;
        active.get(session_id).cloned()
    }?;

    let session = session_arc.lock().await;
    trim_to_option(session.codex_thread_id.as_deref())
}

async fn append_and_emit_assistant_message(
    session_id: &str,
    content: String,
    app: &AppHandle,
) -> Result<(), String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    let assistant_msg = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        role: MessageRole::Assistant,
        content: trimmed.to_string(),
        message_type: MessageType::Text,
        created_at: chrono::Utc::now().timestamp_millis(),
    };

    let mut messages = storage::load_messages(session_id).await;
    messages.push(assistant_msg.clone());
    storage::save_messages(session_id, &messages).await?;

    let payload = serde_json::to_value(&assistant_msg)
        .map_err(|e| format!("Failed to serialize assistant message: {}", e))?;

    let _ = app.emit(
        "session-event",
        SessionEvent {
            session_id: session_id.to_string(),
            event_type: "assistant_message".to_string(),
            data: payload,
        },
    );

    Ok(())
}

async fn handle_codex_readonly_slash_command(
    invocation: &CodexSlashInvocation,
    session_id: &str,
    project_path: &str,
    codex_bin: &Option<String>,
    app: &AppHandle,
) -> Result<bool, String> {
    match invocation.command.as_str() {
        CODEX_MCP_COMMAND => {
            let result = codex_adapter::run_codex_method(
                project_path.to_string(),
                codex_bin.clone(),
                "mcpServerStatus/list",
                json!({}),
            )
            .await?;

            let servers = result
                .get("data")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            let mut lines = Vec::new();
            lines.push(format!("MCP servers: {}", servers.len()));
            for server in servers.iter().take(20) {
                let name = first_non_empty_string(server, &["name"])
                    .unwrap_or_else(|| "unknown".to_string());
                let auth = first_non_empty_string(server, &["authStatus", "auth_status"])
                    .unwrap_or_else(|| "unknown".to_string());
                lines.push(format!("- {} ({})", name, auth));
            }
            if servers.len() > 20 {
                lines.push(format!("...and {} more", servers.len() - 20));
            }

            append_and_emit_assistant_message(session_id, lines.join("\n"), app).await?;
            emit_codex_turn_completed(session_id, app).await;
            Ok(true)
        }
        CODEX_SKILLS_COMMAND => {
            let result = codex_adapter::run_codex_method(
                project_path.to_string(),
                codex_bin.clone(),
                "skills/list",
                json!({}),
            )
            .await?;

            let entries = result
                .get("data")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            let mut names: Vec<String> = Vec::new();
            for entry in entries {
                let skills = entry
                    .get("skills")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                for skill in skills {
                    if let Some(name) = first_non_empty_string(&skill, &["name"]) {
                        names.push(name);
                    }
                }
            }
            names.sort();
            names.dedup();

            let mut lines = Vec::new();
            lines.push(format!("Skills: {}", names.len()));
            for name in names.iter().take(30) {
                lines.push(format!("- {}", name));
            }
            if names.len() > 30 {
                lines.push(format!("...and {} more", names.len() - 30));
            }

            append_and_emit_assistant_message(session_id, lines.join("\n"), app).await?;
            emit_codex_turn_completed(session_id, app).await;
            Ok(true)
        }
        CODEX_APPS_COMMAND => {
            let result = codex_adapter::run_codex_method(
                project_path.to_string(),
                codex_bin.clone(),
                "app/list",
                json!({}),
            )
            .await?;

            let apps = result
                .get("data")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            let mut lines = Vec::new();
            lines.push(format!("Connected apps: {}", apps.len()));
            for app_entry in apps.iter().take(20) {
                let name = first_non_empty_string(app_entry, &["name", "id"])
                    .unwrap_or_else(|| "unknown".to_string());
                lines.push(format!("- {}", name));
            }
            if apps.len() > 20 {
                lines.push(format!("...and {} more", apps.len() - 20));
            }

            append_and_emit_assistant_message(session_id, lines.join("\n"), app).await?;
            emit_codex_turn_completed(session_id, app).await;
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn review_target_from_args(args: &str) -> (Value, String) {
    let trimmed = args.trim();
    if trimmed.is_empty() {
        return (
            json!({ "type": "uncommittedChanges" }),
            "uncommitted changes".to_string(),
        );
    }

    let lower = trimmed.to_ascii_lowercase();
    if let Some(branch) = lower
        .strip_prefix("base ")
        .and_then(|_| trim_to_option(Some(trimmed[5..].trim())))
    {
        return (
            json!({
                "type": "baseBranch",
                "branch": branch,
            }),
            format!("base branch {}", branch),
        );
    }

    if let Some(sha) = lower
        .strip_prefix("commit ")
        .and_then(|_| trim_to_option(Some(trimmed[7..].trim())))
    {
        return (
            json!({
                "type": "commit",
                "sha": sha,
            }),
            format!("commit {}", sha),
        );
    }

    (
        json!({
            "type": "custom",
            "instructions": trimmed,
        }),
        "custom review target".to_string(),
    )
}

async fn emit_codex_turn_completed(session_id: &str, app: &AppHandle) {
    let _ = app.emit(
        "session-event",
        SessionEvent {
            session_id: session_id.to_string(),
            event_type: "codex_message".to_string(),
            data: json!({
                "method": "turn/completed",
                "params": {
                    "turn": {
                        "status": "completed",
                    }
                }
            }),
        },
    );
}

async fn handle_codex_model_slash_command(
    session_id: &str,
    args: &str,
    state: &State<'_, AppState>,
    app: &AppHandle,
) -> Result<(), String> {
    let requested = args.trim();
    if requested.is_empty() {
        let current_model = {
            let data = state.data.lock().await;
            data.sessions
                .iter()
                .find(|s| s.id == session_id)
                .and_then(|s| trim_to_option(s.model.as_deref()))
        };

        let content = match current_model {
            Some(model) => format!("Current model: {}", model),
            None => "Current model: default".to_string(),
        };
        append_and_emit_assistant_message(session_id, content, app).await?;
        emit_codex_turn_completed(session_id, app).await;
        return Ok(());
    }

    let normalized = if requested.eq_ignore_ascii_case("default") {
        None
    } else {
        Some(requested.to_string())
    };

    let mut data = state.data.lock().await;
    let session = data
        .sessions
        .iter_mut()
        .find(|s| s.id == session_id)
        .ok_or("Session not found")?;
    session.model = normalized.clone();
    session.updated_at = chrono::Utc::now().timestamp_millis();
    storage::save_data(&data).await?;
    drop(data);

    let content = match normalized {
        Some(model) => format!("Model set to {}", model),
        None => "Model reset to default".to_string(),
    };
    append_and_emit_assistant_message(session_id, content, app).await?;
    emit_codex_turn_completed(session_id, app).await;
    Ok(())
}

async fn handle_codex_thread_slash_command(
    invocation: &CodexSlashInvocation,
    session_id: &str,
    thread_id: &str,
    model: Option<&str>,
    state: &State<'_, AppState>,
    app: &AppHandle,
    stdin: &mut tokio::process::ChildStdin,
) -> Result<bool, String> {
    match invocation.command.as_str() {
        CODEX_COMPACT_COMMAND => {
            codex_adapter::send_codex_message(
                stdin,
                "thread/compact/start",
                json!({ "threadId": thread_id }),
            )
            .await?;
            append_and_emit_assistant_message(
                session_id,
                "Started compacting the current thread.".to_string(),
                app,
            )
            .await?;
            emit_codex_turn_completed(session_id, app).await;
            Ok(true)
        }
        CODEX_REVIEW_COMMAND => {
            let (target, target_label) = review_target_from_args(&invocation.args);
            codex_adapter::send_codex_message(
                stdin,
                "review/start",
                json!({
                    "threadId": thread_id,
                    "target": target,
                }),
            )
            .await?;
            append_and_emit_assistant_message(
                session_id,
                format!("Started review for {}.", target_label),
                app,
            )
            .await?;
            emit_codex_turn_completed(session_id, app).await;
            Ok(true)
        }
        CODEX_INIT_COMMAND => {
            let mut turn_params = json!({
                "threadId": thread_id,
                "input": [{
                    "type": "text",
                    "text": CODEX_INIT_PROMPT,
                }],
            });

            if let Some(model_name) = trim_to_option(model) {
                if let Some(obj) = turn_params.as_object_mut() {
                    obj.insert("model".to_string(), Value::String(model_name));
                }
            }

            codex_adapter::send_codex_message(stdin, "turn/start", turn_params).await?;
            Ok(true)
        }
        CODEX_RENAME_COMMAND => {
            let new_name = match trim_to_option(Some(&invocation.args)) {
                Some(name) => name,
                None => {
                    append_and_emit_assistant_message(
                        session_id,
                        "Usage: /rename <new thread name>".to_string(),
                        app,
                    )
                    .await?;
                    emit_codex_turn_completed(session_id, app).await;
                    return Ok(true);
                }
            };

            codex_adapter::send_codex_message(
                stdin,
                "thread/name/set",
                json!({
                    "threadId": thread_id,
                    "name": new_name,
                }),
            )
            .await?;

            let mut data = state.data.lock().await;
            if let Some(session) = data.sessions.iter_mut().find(|s| s.id == session_id) {
                session.name = new_name.clone();
                session.updated_at = chrono::Utc::now().timestamp_millis();
                storage::save_data(&data).await?;
            }
            drop(data);

            let _ = app.emit(
                "session-event",
                SessionEvent {
                    session_id: session_id.to_string(),
                    event_type: "session_renamed".to_string(),
                    data: json!({ "name": new_name }),
                },
            );

            append_and_emit_assistant_message(
                session_id,
                "Requested thread rename.".to_string(),
                app,
            )
            .await?;
            emit_codex_turn_completed(session_id, app).await;
            Ok(true)
        }
        CODEX_MODEL_COMMAND => {
            handle_codex_model_slash_command(session_id, &invocation.args, state, app).await?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

async fn handle_codex_status_command(
    session_id: &str,
    project_path: &str,
    codex_bin: &Option<String>,
    model: Option<&str>,
    provider_session_id: Option<&str>,
    state: &State<'_, AppState>,
    app: &AppHandle,
) -> Result<(), String> {
    let project_path_owned = project_path.to_string();
    let codex_bin_owned = codex_bin.clone();
    let active_thread_id = active_codex_thread_id_for_session(session_id, state).await;

    let (config_result, account_result, user_agent_result, rate_limits_result) = tokio::join!(
        codex_adapter::run_codex_method(
            project_path_owned.clone(),
            codex_bin_owned.clone(),
            "config/read",
            json!({}),
        ),
        codex_adapter::run_codex_method(
            project_path_owned.clone(),
            codex_bin_owned.clone(),
            "account/read",
            json!({}),
        ),
        codex_adapter::run_codex_method(
            project_path_owned.clone(),
            codex_bin_owned.clone(),
            "getUserAgent",
            json!({}),
        ),
        codex_adapter::run_codex_method(
            project_path_owned,
            codex_bin_owned,
            "account/rateLimits/read",
            json!({}),
        ),
    );

    let config_value = config_result.ok();
    let config = config_value.as_ref().and_then(|v| v.get("config"));
    let account_value = account_result.ok();
    let account = account_value.as_ref().and_then(|v| v.get("account"));

    let model_name = trim_to_option(model)
        .or_else(|| config.and_then(|c| first_non_empty_string(c, &["model"])))
        .unwrap_or_else(|| "unknown".to_string());
    let reasoning = config
        .and_then(|c| first_non_empty_string(c, &["model_reasoning_effort", "modelReasoningEffort"]))
        .unwrap_or_else(|| "auto".to_string());
    let approval = config
        .and_then(|c| first_non_empty_string(c, &["approval_policy", "approvalPolicy"]))
        .unwrap_or_else(|| "default".to_string());
    let sandbox = config
        .and_then(|c| first_non_empty_string(c, &["sandbox_mode", "sandboxMode"]))
        .unwrap_or_else(|| "default".to_string());
    let personality = config
        .and_then(|c| first_non_empty_string(c, &["personality"]))
        .unwrap_or_else(|| "pragmatic".to_string());

    let account_email = account.and_then(|a| first_non_empty_string(a, &["email"]));
    let account_plan = account.and_then(|a| first_non_empty_string(a, &["planType", "plan_type"]));
    let account_type = account.and_then(|a| first_non_empty_string(a, &["type"]));
    let account_display = match (account_email, account_plan, account_type) {
        (Some(email), Some(plan), _) => format!("{} ({})", email, plan),
        (Some(email), None, Some(kind)) => format!("{} ({})", email, kind),
        (Some(email), None, None) => email,
        (None, Some(plan), _) => plan,
        (None, None, Some(kind)) => kind,
        (None, None, None) => "unavailable".to_string(),
    };

    let user_agent = user_agent_result
        .ok()
        .and_then(|v| first_non_empty_string(&v, &["userAgent", "user_agent"]));
    let cli_version = user_agent
        .as_deref()
        .and_then(extract_codex_version_from_user_agent)
        .map(|v| format!("v{}", v))
        .unwrap_or_else(|| "unknown".to_string());

    let thread_id = active_thread_id
        .or_else(|| trim_to_option(provider_session_id))
        .unwrap_or_else(|| "not started".to_string());

    let agents_path = Path::new(project_path).join("AGENTS.md");
    let agents_md = if agents_path.exists() {
        "AGENTS.md"
    } else {
        "(none)"
    };

    let usage_line = if rate_limits_result.is_ok() {
        "Usage limits: available".to_string()
    } else {
        "Usage limits: unavailable".to_string()
    };

    let mut lines = Vec::new();
    lines.push(format!("OpenAI Codex ({})", cli_version));
    lines.push(format!("Model: {} (reasoning {})", model_name, reasoning));
    lines.push(format!("Directory: {}", project_path));
    lines.push(format!("Approval: {}", approval));
    lines.push(format!("Sandbox: {}", sandbox));
    lines.push(format!("AGENTS.md: {}", agents_md));
    lines.push(format!("Account: {}", account_display));
    lines.push(format!("Session: {}", thread_id));
    lines.push(format!("Personality: {}", personality));
    lines.push("Context window: unavailable".to_string());
    lines.push(usage_line);

    append_and_emit_assistant_message(session_id, lines.join("\n"), app).await?;
    emit_codex_turn_completed(session_id, app).await;

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
    claude_permission_mode: &str,
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
        claude_permission_mode.to_string(),
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
    mut settings: AppSettings,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    settings.window_transparency = settings.window_transparency.min(100);
    settings.claude_permission_mode =
        normalize_claude_permission_mode(&settings.claude_permission_mode);

    let mut data = state.data.lock().await;
    data.settings = settings.clone();
    storage::save_data(&data).await?;
    drop(data);

    let mut s = state.settings.lock().await;
    *s = settings.clone();
    drop(s);

    crate::apply_liquid_glass_effect(&app, settings.window_transparency);

    Ok(())
}

fn normalize_claude_permission_mode(mode: &str) -> String {
    match mode.trim() {
        "acceptEdits" => "acceptEdits".to_string(),
        "bypassPermissions" => "bypassPermissions".to_string(),
        "default" => "default".to_string(),
        "dontAsk" => "dontAsk".to_string(),
        "plan" => "plan".to_string(),
        _ => "acceptEdits".to_string(),
    }
}

// ─── Utility Commands ───

async fn resolve_project_path(project_id: &str, state: &State<'_, AppState>) -> Result<String, String> {
    let data = state.data.lock().await;
    data.projects
        .iter()
        .find(|p| p.id == project_id)
        .map(|p| p.path.clone())
        .ok_or_else(|| "Project not found".to_string())
}

async fn run_git_command(project_path: &str, args: &[&str]) -> Result<Output, String> {
    tokio::process::Command::new("git")
        .arg("-C")
        .arg(project_path)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Failed to run git {}: {}", args.join(" "), e))
}

fn git_error_message(prefix: &str, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        prefix.to_string()
    } else {
        format!("{}: {}", prefix, stderr)
    }
}

fn decode_git_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() < 2 || !trimmed.starts_with('"') || !trimmed.ends_with('"') {
        return trimmed.to_string();
    }

    let mut out = String::new();
    let mut chars = trimmed[1..trimmed.len() - 1].chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }

        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('\\') => out.push('\\'),
            Some('"') => out.push('"'),
            Some(other) => out.push(other),
            None => {}
        }
    }

    out
}

fn is_conflicted_status(index_status: char, worktree_status: char) -> bool {
    matches!(
        (index_status, worktree_status),
        ('D', 'D')
            | ('A', 'U')
            | ('U', 'D')
            | ('U', 'A')
            | ('D', 'U')
            | ('A', 'A')
            | ('U', 'U')
    )
}

fn parse_branch_header(line: &str) -> (Option<String>, i32, i32) {
    let mut branch: Option<String> = None;
    let mut ahead = 0;
    let mut behind = 0;

    let trimmed = line.trim_start_matches("## ").trim();
    let (branch_part, tracking_part) = match trimmed.split_once(" [") {
        Some((b, meta)) => (b.trim(), Some(meta.trim_end_matches(']').trim())),
        None => (trimmed, None),
    };

    if let Some(name) = branch_part.strip_prefix("No commits yet on ") {
        branch = Some(name.to_string());
    } else if !branch_part.starts_with("HEAD ") && !branch_part.starts_with("HEAD(") {
        branch = Some(
            branch_part
                .split("...")
                .next()
                .unwrap_or(branch_part)
                .trim()
                .to_string(),
        );
    }

    if let Some(meta) = tracking_part {
        for segment in meta.split(',') {
            let token = segment.trim();
            if let Some(value) = token.strip_prefix("ahead ") {
                ahead = value.parse::<i32>().unwrap_or(0);
            } else if let Some(value) = token.strip_prefix("behind ") {
                behind = value.parse::<i32>().unwrap_or(0);
            }
        }
    }

    (branch, ahead, behind)
}

fn parse_git_status_line(line: &str) -> Option<GitFileStatus> {
    if line.len() < 4 {
        return None;
    }

    let mut chars = line.chars();
    let index_status = chars.next()?;
    let worktree_status = chars.next()?;
    let _ = chars.next()?;

    let path_field = line[3..].trim();
    if path_field.is_empty() {
        return None;
    }

    let (old_path, path) = match path_field.split_once(" -> ") {
        Some((old, new)) => (Some(decode_git_path(old)), decode_git_path(new)),
        None => (None, decode_git_path(path_field)),
    };

    let untracked = index_status == '?' && worktree_status == '?';
    let staged = !untracked && index_status != ' ';
    let unstaged = worktree_status != ' ';
    let conflicted = is_conflicted_status(index_status, worktree_status);

    Some(GitFileStatus {
        path,
        old_path,
        index_status: index_status.to_string(),
        worktree_status: worktree_status.to_string(),
        staged,
        unstaged,
        untracked,
        conflicted,
    })
}

#[cfg(target_os = "windows")]
fn git_null_device() -> &'static str {
    "NUL"
}

#[cfg(not(target_os = "windows"))]
fn git_null_device() -> &'static str {
    "/dev/null"
}

#[tauri::command]
pub async fn get_git_status(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<GitStatusResponse, String> {
    let project_path = resolve_project_path(&project_id, &state).await?;

    let repo_check = run_git_command(&project_path, &["rev-parse", "--is-inside-work-tree"]).await?;
    if !repo_check.status.success() {
        return Ok(GitStatusResponse {
            is_git_repo: false,
            branch: None,
            ahead: 0,
            behind: 0,
            files: Vec::new(),
        });
    }

    let inside = String::from_utf8_lossy(&repo_check.stdout).trim().to_string();
    if inside != "true" {
        return Ok(GitStatusResponse {
            is_git_repo: false,
            branch: None,
            ahead: 0,
            behind: 0,
            files: Vec::new(),
        });
    }

    let output = run_git_command(&project_path, &["status", "--porcelain", "--branch"]).await?;
    if !output.status.success() {
        return Err(git_error_message("Failed to read git status", &output));
    }

    let content = String::from_utf8_lossy(&output.stdout);
    let mut branch = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut files = Vec::new();

    for line in content.lines() {
        if let Some(header) = line.strip_prefix("## ") {
            let (parsed_branch, parsed_ahead, parsed_behind) =
                parse_branch_header(&format!("## {}", header));
            branch = parsed_branch;
            ahead = parsed_ahead;
            behind = parsed_behind;
            continue;
        }

        if let Some(entry) = parse_git_status_line(line) {
            files.push(entry);
        }
    }

    Ok(GitStatusResponse {
        is_git_repo: true,
        branch,
        ahead,
        behind,
        files,
    })
}

#[tauri::command]
pub async fn get_git_file_diff(
    project_id: String,
    file_path: String,
    state: State<'_, AppState>,
) -> Result<GitFileDiffResponse, String> {
    let project_path = resolve_project_path(&project_id, &state).await?;
    let file_arg = file_path.as_str();

    let staged_output = run_git_command(&project_path, &["diff", "--cached", "--", file_arg]).await?;
    if !staged_output.status.success() {
        return Err(git_error_message("Failed to read staged diff", &staged_output));
    }
    let staged_text = String::from_utf8_lossy(&staged_output.stdout).to_string();
    let staged_patch = if staged_text.trim().is_empty() {
        None
    } else {
        Some(staged_text)
    };

    let unstaged_output = run_git_command(&project_path, &["diff", "--", file_arg]).await?;
    if !unstaged_output.status.success() {
        return Err(git_error_message("Failed to read unstaged diff", &unstaged_output));
    }
    let unstaged_text = String::from_utf8_lossy(&unstaged_output.stdout).to_string();
    let mut unstaged_patch = if unstaged_text.trim().is_empty() {
        None
    } else {
        Some(unstaged_text)
    };

    if unstaged_patch.is_none() {
        let untracked_check = run_git_command(
            &project_path,
            &["ls-files", "--others", "--exclude-standard", "--", file_arg],
        )
        .await?;
        if !untracked_check.status.success() {
            return Err(git_error_message(
                "Failed to inspect untracked files",
                &untracked_check,
            ));
        }

        if !String::from_utf8_lossy(&untracked_check.stdout).trim().is_empty() {
            let untracked_output = run_git_command(
                &project_path,
                &["diff", "--no-index", "--", git_null_device(), file_arg],
            )
            .await?;
            if !(untracked_output.status.success() || untracked_output.status.code() == Some(1)) {
                return Err(git_error_message(
                    "Failed to read untracked file diff",
                    &untracked_output,
                ));
            }

            let untracked_text = String::from_utf8_lossy(&untracked_output.stdout).to_string();
            if !untracked_text.trim().is_empty() {
                unstaged_patch = Some(untracked_text);
            }
        }
    }

    Ok(GitFileDiffResponse {
        staged_patch,
        unstaged_patch,
    })
}

#[tauri::command]
pub async fn git_stage_file(
    project_id: String,
    file_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let project_path = resolve_project_path(&project_id, &state).await?;
    let file_arg = file_path.as_str();
    let output = run_git_command(&project_path, &["add", "--", file_arg]).await?;
    if !output.status.success() {
        return Err(git_error_message("Failed to stage file", &output));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_unstage_file(
    project_id: String,
    file_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let project_path = resolve_project_path(&project_id, &state).await?;
    let file_arg = file_path.as_str();

    let restore = run_git_command(&project_path, &["restore", "--staged", "--", file_arg]).await?;
    if restore.status.success() {
        return Ok(());
    }

    let reset = run_git_command(&project_path, &["reset", "HEAD", "--", file_arg]).await?;
    if !reset.status.success() {
        return Err(git_error_message("Failed to unstage file", &reset));
    }

    Ok(())
}

#[tauri::command]
pub async fn git_discard_file(
    project_id: String,
    file_path: String,
    untracked: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let project_path = resolve_project_path(&project_id, &state).await?;
    let file_arg = file_path.as_str();

    if untracked {
        let clean = run_git_command(&project_path, &["clean", "-f", "--", file_arg]).await?;
        if !clean.status.success() {
            return Err(git_error_message("Failed to discard untracked file", &clean));
        }
        return Ok(());
    }

    let head_ref = format!("HEAD:{}", file_arg);
    let tracked_in_head = run_git_command(&project_path, &["cat-file", "-e", head_ref.as_str()])
        .await?
        .status
        .success();

    if tracked_in_head {
        let restore = run_git_command(
            &project_path,
            &["restore", "--source=HEAD", "--staged", "--worktree", "--", file_arg],
        )
        .await?;
        if !restore.status.success() {
            return Err(git_error_message("Failed to discard file changes", &restore));
        }
        return Ok(());
    }

    let rm_cached = run_git_command(&project_path, &["rm", "--cached", "-f", "--", file_arg]).await?;
    if !rm_cached.status.success() {
        return Err(git_error_message("Failed to discard newly added file", &rm_cached));
    }

    let clean = run_git_command(&project_path, &["clean", "-f", "--", file_arg]).await?;
    if !clean.status.success() {
        return Err(git_error_message("Failed to remove discarded file", &clean));
    }

    Ok(())
}

const DEFAULT_CODEX_SLASH_COMMANDS: &[(&str, &str)] = &[
    ("/apps", "Browse or manage connected ChatGPT apps."),
    ("/collab", "Open collaboration mode controls."),
    ("/compact", "Compact the current conversation to save context."),
    ("/environments", "Inspect available execution environments."),
    ("/experimental", "Toggle experimental Codex features."),
    ("/feedback", "Send logs and feedback to Codex maintainers."),
    ("/fork", "Fork the current thread into a new one."),
    ("/init", "Create an AGENTS.md for project-specific guidance."),
    ("/mcp", "List configured MCP tools and servers."),
    ("/model", "Switch model or reasoning effort."),
    ("/new", "Start a fresh thread."),
    ("/permissions", "Adjust approval and permission behavior."),
    ("/personality", "Choose Codex communication style."),
    ("/plan", "Switch to plan mode."),
    ("/ps", "View active turns and related process state."),
    ("/rename", "Rename the current thread."),
    ("/review", "Run a code review on current changes."),
    ("/skills", "List and inspect available skills."),
    ("/status", "Show model, approvals, and usage status."),
    ("/usage", "Show usage and rate-limit details."),
];

fn resolve_codex_bin_for_slash_commands(custom: &Option<String>) -> String {
    match custom {
        Some(bin) if !bin.trim().is_empty() => bin.trim().to_string(),
        _ => "codex".to_string(),
    }
}

fn is_slash_command_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'
}

fn extract_slash_tokens(line: &str) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut result = Vec::new();
    let mut i = 0;

    while i < chars.len() {
        if chars[i] != '/' {
            i += 1;
            continue;
        }

        let prev_is_command_char = i > 0 && is_slash_command_char(chars[i - 1]);
        if prev_is_command_char {
            i += 1;
            continue;
        }

        let mut j = i + 1;
        while j < chars.len() && is_slash_command_char(chars[j]) {
            j += 1;
        }

        if j > i + 1 {
            let token: String = chars[i..j].iter().collect();
            if token.len() <= 32 {
                result.push(token.to_ascii_lowercase());
            }
        }

        i = j;
    }

    result
}

fn parse_codex_slash_commands_from_strings(output: &str) -> HashSet<String> {
    let mut commands = HashSet::new();

    for line in output.lines() {
        let lower = line.to_ascii_lowercase();
        if !(lower.contains("use /")
            || lower.contains("run /")
            || lower.contains("type /")
            || lower.contains("try /")
            || lower.contains("to use /")
            || lower.contains("command popup"))
        {
            continue;
        }

        for token in extract_slash_tokens(line) {
            commands.insert(token);
        }
    }

    commands
}

#[cfg(not(target_os = "windows"))]
async fn discover_codex_slash_commands(codex_bin: &str) -> HashSet<String> {
    let output = match tokio::process::Command::new("strings")
        .arg(codex_bin)
        .output()
        .await
    {
        Ok(out) if out.status.success() => out,
        _ => return HashSet::new(),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_codex_slash_commands_from_strings(&stdout)
}

#[cfg(target_os = "windows")]
async fn discover_codex_slash_commands(_codex_bin: &str) -> HashSet<String> {
    HashSet::new()
}

#[tauri::command]
pub async fn list_codex_slash_commands(
    state: State<'_, AppState>,
) -> Result<Vec<SlashCommand>, String> {
    let codex_bin = {
        let data = state.data.lock().await;
        resolve_codex_bin_for_slash_commands(&data.settings.codex_bin)
    };

    let mut merged: BTreeMap<String, String> = BTreeMap::new();
    for (command, description) in DEFAULT_CODEX_SLASH_COMMANDS {
        merged.insert((*command).to_string(), (*description).to_string());
    }

    for discovered in discover_codex_slash_commands(&codex_bin).await {
        merged.entry(discovered).or_default();
    }

    Ok(merged
        .into_iter()
        .map(|(command, description)| SlashCommand { command, description })
        .collect())
}

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
        .unwrap_or_else(|_| std::env::temp_dir().join("polycode-cache"))
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
