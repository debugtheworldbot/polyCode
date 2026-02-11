use std::path::PathBuf;
use tokio::fs;
use sha2::{Sha256, Digest};
use chrono::DateTime;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use crate::storage;
use crate::types::{ChatMessage, MessageRole, MessageType, SessionEvent};

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
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    thoughts: Vec<GeminiThought>,
    #[serde(rename = "toolCalls", default)]
    tool_calls: Vec<GeminiToolCall>,
}

#[derive(serde::Deserialize)]
struct GeminiThought {
    #[serde(default)]
    subject: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
}

#[derive(serde::Deserialize)]
struct GeminiToolCall {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(rename = "resultDisplay", default)]
    result_display: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    args: Option<Value>,
    #[serde(default)]
    timestamp: Option<String>,
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

fn resolve_gemini_bin(custom: &Option<String>) -> String {
    if let Some(bin) = custom {
        if !bin.trim().is_empty() {
            return bin.clone();
        }
    }
    "gemini".to_string()
}

fn should_ignore_gemini_stderr(line: &str) -> bool {
    let normalized = line.trim().to_ascii_lowercase();
    normalized.contains("error flushing log events")
        || normalized.contains("play.googleapis.com")
        || normalized.starts_with("at ")
}

pub async fn spawn_gemini_session(
    session_id: String,
    project_path: String,
    prompt: String,
    gemini_bin: Option<String>,
    model: Option<String>,
    app_handle: AppHandle,
) -> Result<tokio::process::Child, String> {
    let bin = resolve_gemini_bin(&gemini_bin);

    let mut cmd = Command::new(&bin);
    cmd.arg("-p").arg(&prompt);

    if let Some(model_name) = model {
        let trimmed = model_name.trim();
        if !trimmed.is_empty() {
            cmd.arg("--model").arg(trimmed);
        }
    }

    cmd.current_dir(&project_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to spawn gemini: {}. Is '{}' installed and in PATH?",
            e, bin
        )
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture gemini stdout")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Failed to capture gemini stderr")?;

    let sid = session_id.clone();
    let handle = app_handle.clone();

    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        let mut result = String::new();

        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }

            let delta = if result.is_empty() {
                line.clone()
            } else {
                format!("\n{}", line)
            };
            result.push_str(&delta);

            let _ = handle.emit(
                "session-event",
                SessionEvent {
                    session_id: sid.clone(),
                    event_type: "gemini_stream".to_string(),
                    data: json!({
                        "delta": delta,
                    }),
                },
            );
        }

        if !result.trim().is_empty() {
            if let Err(e) = storage::append_assistant_text_message(&sid, &result).await {
                let _ = handle.emit(
                    "session-event",
                    SessionEvent {
                        session_id: sid.clone(),
                        event_type: "gemini_error".to_string(),
                        data: json!({ "message": format!("Failed to persist Gemini message: {}", e) }),
                    },
                );
            }
        }

        let _ = handle.emit(
            "session-event",
            SessionEvent {
                session_id: sid.clone(),
                event_type: "gemini_result".to_string(),
                data: json!({
                    "result": result,
                }),
            },
        );
    });

    let sid2 = session_id.clone();
    let handle2 = app_handle.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() || should_ignore_gemini_stderr(trimmed) {
                continue;
            }
            let _ = handle2.emit(
                "session-event",
                SessionEvent {
                    session_id: sid2.clone(),
                    event_type: "gemini_error".to_string(),
                    data: json!({ "message": trimmed }),
                },
            );
        }
    });

    Ok(child)
}

pub async fn read_gemini_session(path: &PathBuf) -> Result<(String, i64, Vec<ChatMessage>), String> {
    let content = fs::read_to_string(path).await.map_err(|e| e.to_string())?;
    let session: GeminiSession = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let updated_at = parse_timestamp_ms(Some(&session.last_updated));
    let mut messages: Vec<ChatMessage> = Vec::new();

    for msg in session.messages {
        let created_at = parse_timestamp_ms(Some(&msg.timestamp));
        let text_content = non_empty_trimmed(msg.content.as_deref());

        match msg.msg_type.as_str() {
            "user" => {
                if let Some(content) = text_content {
                    messages.push(ChatMessage {
                        id: msg.id,
                        session_id: session.session_id.clone(),
                        role: MessageRole::User,
                        content,
                        message_type: MessageType::Text,
                        created_at,
                    });
                }
            }
            "gemini" | "model" => {
                for (idx, thought) in msg.thoughts.iter().enumerate() {
                    if let Some(reasoning) = format_gemini_thought(thought) {
                        messages.push(ChatMessage {
                            id: format!("{}:reasoning:{}", msg.id, idx),
                            session_id: session.session_id.clone(),
                            role: MessageRole::Assistant,
                            content: reasoning,
                            message_type: MessageType::Reasoning,
                            created_at: parse_timestamp_ms(thought.timestamp.as_deref()),
                        });
                    }
                }

                for (idx, tool_call) in msg.tool_calls.iter().enumerate() {
                    if let Some(tool_content) = format_gemini_tool_call(tool_call) {
                        messages.push(ChatMessage {
                            id: format!(
                                "{}:tool:{}",
                                msg.id,
                                tool_call.id.clone().unwrap_or_else(|| idx.to_string())
                            ),
                            session_id: session.session_id.clone(),
                            role: MessageRole::Assistant,
                            content: tool_content,
                            message_type: MessageType::Tool,
                            created_at: parse_timestamp_ms(tool_call.timestamp.as_deref()),
                        });
                    }
                }

                if let Some(content) = text_content {
                    messages.push(ChatMessage {
                        id: msg.id,
                        session_id: session.session_id.clone(),
                        role: MessageRole::Assistant,
                        content,
                        message_type: MessageType::Text,
                        created_at,
                    });
                }
            }
            "tool" => {
                if let Some(content) = text_content {
                    messages.push(ChatMessage {
                        id: msg.id,
                        session_id: session.session_id.clone(),
                        role: MessageRole::Assistant,
                        content,
                        message_type: MessageType::Tool,
                        created_at,
                    });
                }
            }
            "system" | "info" => {
                if let Some(content) = text_content {
                    messages.push(ChatMessage {
                        id: msg.id,
                        session_id: session.session_id.clone(),
                        role: MessageRole::System,
                        content,
                        message_type: MessageType::Text,
                        created_at,
                    });
                }
            }
            _ => {
                if let Some(content) = text_content {
                    messages.push(ChatMessage {
                        id: msg.id,
                        session_id: session.session_id.clone(),
                        role: MessageRole::Assistant,
                        content,
                        message_type: MessageType::Text,
                        created_at,
                    });
                }
            }
        }
    }

    Ok((session.session_id, updated_at, messages))
}

fn parse_timestamp_ms(timestamp: Option<&str>) -> i64 {
    timestamp
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis())
}

fn non_empty_trimmed(value: Option<&str>) -> Option<String> {
    let text = value?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn format_gemini_thought(thought: &GeminiThought) -> Option<String> {
    let subject = non_empty_trimmed(thought.subject.as_deref());
    let description = non_empty_trimmed(thought.description.as_deref());

    match (subject, description) {
        (Some(subject), Some(description)) => Some(format!("{}: {}", subject, description)),
        (Some(subject), None) => Some(subject),
        (None, Some(description)) => Some(description),
        (None, None) => None,
    }
}

fn format_gemini_tool_call(tool_call: &GeminiToolCall) -> Option<String> {
    let name = non_empty_trimmed(tool_call.display_name.as_deref())
        .or_else(|| non_empty_trimmed(tool_call.name.as_deref()))
        .unwrap_or_else(|| "Tool".to_string());
    let status = non_empty_trimmed(tool_call.status.as_deref())
        .filter(|s| !s.eq_ignore_ascii_case("success"));
    let result_display = non_empty_trimmed(tool_call.result_display.as_deref());
    let args = format_gemini_tool_args(tool_call.args.as_ref());

    let title = match status {
        Some(status) => format!("{} ({})", name, status),
        None => name,
    };

    if let Some(details) = result_display.or(args) {
        Some(format!("{}\n{}", title, details))
    } else if title.trim().is_empty() {
        None
    } else {
        Some(title)
    }
}

fn format_gemini_tool_args(args: Option<&Value>) -> Option<String> {
    let args = args?;
    if args.is_null() {
        return None;
    }
    if let Some(obj) = args.as_object() {
        if obj.is_empty() {
            return None;
        }
    }
    let serialized = serde_json::to_string(args).ok()?;
    let truncated: String = serialized.chars().take(240).collect();
    if serialized.chars().count() > 240 {
        Some(format!("Args: {}…", truncated))
    } else {
        Some(format!("Args: {}", serialized))
    }
}
