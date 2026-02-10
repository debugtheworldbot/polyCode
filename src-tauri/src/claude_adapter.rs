use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::storage;
use crate::types::SessionEvent;

/// Resolve the claude binary path
fn resolve_claude_bin(custom: &Option<String>) -> String {
    if let Some(bin) = custom {
        if !bin.is_empty() {
            return bin.clone();
        }
    }
    "claude".to_string()
}

/// Spawn a Claude Code CLI process for a message
/// Claude Code uses `claude -p "<prompt>" --output-format stream-json`
/// For continuing conversations, use `--resume <session_id>`
pub async fn spawn_claude_session(
    session_id: String,
    project_path: String,
    prompt: String,
    claude_bin: Option<String>,
    provider_session_id: Option<String>,
    app_handle: AppHandle,
) -> Result<tokio::process::Child, String> {
    let bin = resolve_claude_bin(&claude_bin);

    let mut cmd = Command::new(&bin);
    cmd.arg("-p")
        .arg(&prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose");

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

/// Parse a Claude Code JSON result to extract session_id
pub fn extract_session_id(data: &Value) -> Option<String> {
    data.get("session_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Parse Claude Code stream events to extract text content
pub fn extract_text_from_stream(data: &Value) -> Option<String> {
    // stream_event with text_delta
    if let Some(event) = data.get("event") {
        if let Some(delta) = event.get("delta") {
            if delta.get("type").and_then(|t| t.as_str()) == Some("text_delta") {
                return delta.get("text").and_then(|t| t.as_str()).map(|s| s.to_string());
            }
        }
    }
    // result type
    if data.get("type").and_then(|t| t.as_str()) == Some("result") {
        return data.get("result").and_then(|r| r.as_str()).map(|s| s.to_string());
    }
    None
}

fn extract_claude_final_text(data: &Value) -> Option<String> {
    if data.get("type").and_then(|t| t.as_str()) != Some("result") {
        return None;
    }

    data.get("result")
        .and_then(|r| r.as_str())
        .map(|s| s.to_string())
}
