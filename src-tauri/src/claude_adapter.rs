use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::state::AppState;
use crate::storage;
use crate::types::{AIProvider, ChatMessage, MessageRole, MessageType, SessionEvent};

/// Resolve the claude binary path
fn resolve_claude_bin(custom: &Option<String>) -> String {
    if let Some(bin) = custom {
        if !bin.is_empty() {
            return bin.clone();
        }
    }
    "claude".to_string()
}

fn resolve_claude_permission_mode(mode: &str) -> &str {
    match mode.trim() {
        "acceptEdits" => "acceptEdits",
        "bypassPermissions" => "bypassPermissions",
        "default" => "default",
        "dontAsk" => "dontAsk",
        "plan" => "plan",
        _ => "acceptEdits",
    }
}

/// Spawn a Claude Code CLI process for a message
/// Claude Code uses `claude -p "<prompt>" --output-format stream-json`
/// For continuing conversations, use `--resume <session_id>`
pub async fn spawn_claude_session(
    session_id: String,
    project_path: String,
    prompt: String,
    claude_bin: Option<String>,
    claude_permission_mode: String,
    model: Option<String>,
    provider_session_id: Option<String>,
    app_handle: AppHandle,
) -> Result<tokio::process::Child, String> {
    let bin = resolve_claude_bin(&claude_bin);
    let permission_mode = resolve_claude_permission_mode(&claude_permission_mode);

    let mut cmd = Command::new(&bin);
    cmd.arg("-p")
        .arg(&prompt)
        .arg("--output-format")
        .arg("stream-json")
        // `-p` is non-interactive, so choose a permission strategy up front.
        .arg("--permission-mode")
        .arg(permission_mode)
        .arg("--verbose");

    if let Some(model_name) = model {
        let trimmed = model_name.trim();
        if !trimmed.is_empty() {
            cmd.arg("--model").arg(trimmed);
        }
    }

    // If we have a previous session, resume it
    if let Some(ref prev_sid) = provider_session_id {
        cmd.arg("--resume").arg(prev_sid);
    }

    cmd.current_dir(&project_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to spawn claude: {}. Is '{}' installed and in PATH?",
            e, bin
        )
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture claude stdout")?;

    let stderr = child
        .stderr
        .take()
        .ok_or("Failed to capture claude stderr")?;

    let sid = session_id.clone();
    let handle = app_handle.clone();

    // Read stdout (stream-json from Claude Code)
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let data: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => json!({ "raw": line }),
            };

            // Extract session_id from the result message if present
            let event_type = if data.get("type").and_then(|t| t.as_str()) == Some("result") {
                "claude_result".to_string()
            } else if data.get("type").and_then(|t| t.as_str()) == Some("stream_event") {
                "claude_stream".to_string()
            } else {
                "claude_message".to_string()
            };

            let event = SessionEvent {
                session_id: sid.clone(),
                event_type,
                data: data.clone(),
            };

            let _ = handle.emit("session-event", &event);

            if let Some(text) = extract_claude_final_text(&data) {
                if let Err(e) = storage::append_assistant_text_message(&sid, &text).await {
                    let _ = handle.emit(
                        "session-event",
                        &SessionEvent {
                            session_id: sid.clone(),
                            event_type: "claude_error".to_string(),
                            data: json!({ "message": format!("Failed to persist Claude message: {}", e) }),
                        },
                    );
                }

                // Auto-rename session from assistant response
                let suggested = derive_claude_title_from_response(&text);
                if !suggested.is_empty() {
                    if let Ok(true) = maybe_auto_rename_claude_session(&handle, &sid, &suggested).await {
                        let _ = handle.emit(
                            "session-event",
                            &SessionEvent {
                                session_id: sid.clone(),
                                event_type: "session_renamed".to_string(),
                                data: json!({ "name": suggested }),
                            },
                        );
                    }
                }
            }
        }

        // Signal that the process has ended
        let event = SessionEvent {
            session_id: sid.clone(),
            event_type: "claude_done".to_string(),
            data: json!({ "status": "completed" }),
        };
        let _ = handle.emit("session-event", &event);
    });

    // Read stderr
    let sid2 = session_id.clone();
    let handle2 = app_handle.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let event = SessionEvent {
                session_id: sid2.clone(),
                event_type: "claude_error".to_string(),
                data: json!({ "message": line }),
            };
            let _ = handle2.emit("session-event", &event);
        }
    });

    Ok(child)
}

fn extract_claude_final_text(data: &Value) -> Option<String> {
    if data.get("type").and_then(|t| t.as_str()) != Some("result") {
        return None;
    }

    data.get("result")
        .and_then(|r| r.as_str())
        .map(|s| s.to_string())
}

// ─── Claude Code Session Sync ───

/// Metadata about a Claude Code session discovered on disk.
pub struct ClaudeSessionInfo {
    pub session_id: String,
    pub preview: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// Convert a project path to the Claude Code projects directory hash.
/// `/Users/tian/Developer/polycode` → `-Users-tian-Developer-polycode`
fn project_path_to_hash(project_path: &str) -> String {
    project_path.replace('/', "-").replace('\\', "-")
}

/// Get the Claude Code projects directory for a given project path.
fn claude_sessions_dir(project_path: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let hash = project_path_to_hash(project_path);
    let dir = home.join(".claude").join("projects").join(hash);
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

/// List all Claude Code sessions for a project path.
pub async fn list_claude_sessions(project_path: &str) -> Vec<ClaudeSessionInfo> {
    let dir = match claude_sessions_dir(project_path) {
        Some(d) => d,
        None => return vec![],
    };

    let mut sessions = Vec::new();
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(e) => e,
        Err(_) => return vec![],
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }

        let session_id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };

        // Quick parse: read first few and last few lines to get preview + timestamps
        if let Some(info) = parse_claude_session_info(&path, &session_id).await {
            sessions.push(info);
        }
    }

    sessions
}

async fn parse_claude_session_info(path: &Path, session_id: &str) -> Option<ClaudeSessionInfo> {
    let content = tokio::fs::read_to_string(path).await.ok()?;
    let mut preview = String::new();
    let mut first_ts: Option<i64> = None;
    let mut last_ts: Option<i64> = None;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let data: Value = serde_json::from_str(line).ok()?;
        let entry_type = data.get("type").and_then(|t| t.as_str()).unwrap_or("");

        if entry_type != "user" && entry_type != "assistant" {
            continue;
        }

        if let Some(ts) = parse_timestamp(&data) {
            if first_ts.is_none() {
                first_ts = Some(ts);
            }
            last_ts = Some(ts);
        }

        if preview.is_empty() && entry_type == "user" {
            preview = extract_message_text(&data).unwrap_or_default();
        }
    }

    let now = chrono::Utc::now().timestamp_millis();
    Some(ClaudeSessionInfo {
        session_id: session_id.to_string(),
        preview,
        created_at_ms: first_ts.unwrap_or(now),
        updated_at_ms: last_ts.unwrap_or(now),
    })
}

/// Read all messages from a Claude Code session JSONL file.
pub async fn read_claude_session_messages(
    project_path: &str,
    claude_session_id: &str,
    our_session_id: &str,
) -> Result<Vec<ChatMessage>, String> {
    let dir = claude_sessions_dir(project_path)
        .ok_or_else(|| "Claude sessions directory not found".to_string())?;
    let path = dir.join(format!("{}.jsonl", claude_session_id));

    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read Claude session file: {}", e))?;

    let mut messages = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let data: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let entry_type = match data.get("type").and_then(|t| t.as_str()) {
            Some(t) => t,
            None => continue,
        };

        let (role, message_type) = match entry_type {
            "user" => (MessageRole::User, MessageType::Text),
            "assistant" => (MessageRole::Assistant, MessageType::Text),
            _ => continue,
        };

        let text = match extract_message_text(&data) {
            Some(t) if !t.trim().is_empty() => t,
            _ => continue,
        };

        let ts = parse_timestamp(&data).unwrap_or(0);
        let uuid = data
            .get("uuid")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        messages.push(ChatMessage {
            id: if uuid.is_empty() {
                uuid::Uuid::new_v4().to_string()
            } else {
                uuid
            },
            session_id: our_session_id.to_string(),
            role,
            content: text,
            message_type,
            created_at: ts,
        });
    }

    Ok(messages)
}

fn parse_timestamp(data: &Value) -> Option<i64> {
    let ts_str = data.get("timestamp").and_then(|v| v.as_str())?;
    chrono::DateTime::parse_from_rfc3339(ts_str)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// Derive a short title from the assistant's response text.
/// Takes the first non-empty line, strips markdown markers, truncates to 50 chars.
fn derive_claude_title_from_response(text: &str) -> String {
    let first_line = text
        .lines()
        .map(|l| l.trim())
        .map(|l| l.trim_start_matches('#').trim())
        .find(|l| !l.is_empty() && l.len() > 2)
        .unwrap_or("");

    if first_line.is_empty() {
        return String::new();
    }

    let mut truncated: String = first_line.chars().take(50).collect();
    if first_line.chars().count() > 50 {
        truncated.push('\u{2026}');
    }
    truncated
}

/// Auto-rename a Claude session if it still has the default name.
async fn maybe_auto_rename_claude_session(
    app_handle: &AppHandle,
    session_id: &str,
    suggested_name: &str,
) -> Result<bool, String> {
    let state = app_handle.state::<AppState>();
    let mut data = state.data.lock().await;

    let session = match data.sessions.iter_mut().find(|s| s.id == session_id) {
        Some(s) => s,
        None => return Ok(false),
    };

    if session.provider != AIProvider::Claude {
        return Ok(false);
    }

    if !session.name.trim().eq_ignore_ascii_case("Claude Session") {
        return Ok(false);
    }

    if session.name == suggested_name {
        return Ok(false);
    }

    session.name = suggested_name.to_string();
    session.updated_at = chrono::Utc::now().timestamp_millis();

    let data_snapshot = data.clone();
    drop(data);

    storage::save_data(&data_snapshot).await?;
    Ok(true)
}

fn extract_message_text(data: &Value) -> Option<String> {
    let message = data.get("message")?;
    let content = message.get("content")?;

    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }

    if let Some(arr) = content.as_array() {
        let mut parts = Vec::new();
        for item in arr {
            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    parts.push(text.to_string());
                }
            }
        }
        if !parts.is_empty() {
            return Some(parts.join("\n"));
        }
    }

    None
}
