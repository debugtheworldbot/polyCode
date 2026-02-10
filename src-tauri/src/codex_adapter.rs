use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::{timeout, Duration};

use crate::storage;
use crate::state::AppState;
use crate::types::{AIProvider, ChatMessage, MessageRole, MessageType, SessionEvent};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn should_ignore_codex_stderr(line: &str) -> bool {
    let normalized = line.to_ascii_lowercase();
    normalized.contains("state db missing rollout path for thread")
        || normalized.contains("falling back on rollout system")
}

#[derive(Debug, Clone)]
pub struct CodexThreadSummary {
    pub thread_id: String,
    pub preview: String,
    pub cwd: String,
    pub created_at_secs: i64,
    pub updated_at_secs: i64,
}

/// Resolve the codex binary path
fn resolve_codex_bin(custom: &Option<String>) -> String {
    if let Some(bin) = custom {
        if !bin.is_empty() {
            return bin.clone();
        }
    }
    "codex".to_string()
}

/// Spawn a codex app-server process for a workspace
pub async fn spawn_codex_session(
    session_id: String,
    project_path: String,
    codex_bin: Option<String>,
    model: Option<String>,
    resume_thread_id: Option<String>,
    app_handle: AppHandle,
) -> Result<(tokio::process::Child, String), String> {
    let bin = resolve_codex_bin(&codex_bin);

    let mut cmd = Command::new(&bin);
    cmd.arg("app-server");

    if let Some(model_name) = model {
        let trimmed = model_name.trim();
        if !trimmed.is_empty() {
            let escaped = trimmed.replace('"', "\\\"");
            cmd.arg("-c").arg(format!("model=\"{}\"", escaped));
        }
    }

    cmd
        .current_dir(&project_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn codex app-server: {}. Is '{}' installed and in PATH?", e, bin))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture codex stdout")?;

    let stderr = child
        .stderr
        .take()
        .ok_or("Failed to capture codex stderr")?;

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
            if should_ignore_codex_stderr(&line) {
                continue;
            }
            let event = SessionEvent {
                session_id: sid2.clone(),
                event_type: "codex_error".to_string(),
                data: json!({ "message": line }),
            };
            let _ = handle2.emit("session-event", &event);
        }
    });

    // Perform startup handshake on stdout before switching to background streaming.
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    let stdin = child.stdin.as_mut().ok_or("Failed to capture codex stdin")?;

    let init_id = send_codex_message(
        stdin,
        "initialize",
        json!({
            "clientInfo": {
                "name": "polycode",
                "title": "polyCode",
                "version": "0.1.0"
            },
            "capabilities": {
                "experimentalApi": true
            }
        }),
    )
    .await?;

    timeout(
        Duration::from_secs(20),
        wait_for_response(&mut lines, init_id, &session_id, &app_handle),
    )
    .await
    .map_err(|_| "Timed out waiting for Codex initialize response".to_string())??;

    let (open_thread_method, open_thread_params) = if let Some(thread_id) = resume_thread_id {
        ("thread/resume", json!({ "threadId": thread_id }))
    } else {
        ("thread/start", json!({}))
    };
    let open_thread_id = send_codex_message(stdin, open_thread_method, open_thread_params).await?;
    let open_thread_result = timeout(
        Duration::from_secs(20),
        wait_for_response(&mut lines, open_thread_id, &session_id, &app_handle),
    )
    .await
    .map_err(|_| format!("Timed out waiting for Codex {} response", open_thread_method))??;

    let codex_thread_id = extract_thread_id(&open_thread_result).ok_or_else(|| {
        format!(
            "Codex {} response did not include thread id: {}",
            open_thread_method, open_thread_result
        )
    })?;

    let sid = session_id.clone();
    let handle = app_handle.clone();

    // Read stdout (JSONL from app-server) for ongoing events after handshake.
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let data: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => json!({ "raw": line }),
            };

            let event = SessionEvent {
                session_id: sid.clone(),
                event_type: "codex_message".to_string(),
                data: data.clone(),
            };

            let _ = handle.emit("session-event", &event);

            if let Some(text) = extract_codex_final_text(&data) {
                if let Err(e) = storage::append_assistant_text_message(&sid, &text).await {
                    let _ = handle.emit(
                        "session-event",
                        &SessionEvent {
                            session_id: sid.clone(),
                            event_type: "codex_error".to_string(),
                            data: json!({ "message": format!("Failed to persist Codex message: {}", e) }),
                        },
                    );
                }
            }

            if let Some(name) = extract_codex_thread_name(&data) {
                match maybe_auto_rename_session(&handle, &sid, &name).await {
                    Ok(true) => {
                        let _ = handle.emit(
                            "session-event",
                            &SessionEvent {
                                session_id: sid.clone(),
                                event_type: "session_renamed".to_string(),
                                data: json!({ "name": name }),
                            },
                        );
                    }
                    Ok(false) => {}
                    Err(e) => {
                        let _ = handle.emit(
                            "session-event",
                            &SessionEvent {
                                session_id: sid.clone(),
                                event_type: "codex_error".to_string(),
                                data: json!({ "message": format!("Failed to auto-rename session: {}", e) }),
                            },
                        );
                    }
                }
            }
        }
    });

    Ok((child, codex_thread_id))
}

/// Send a JSON-RPC message to a codex app-server process
pub async fn send_codex_message(
    stdin: &mut tokio::process::ChildStdin,
    method: &str,
    params: Value,
) -> Result<u64, String> {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let msg = json!({
        "id": id,
        "method": method,
        "params": params,
    });
    let msg_str = format!("{}\n", serde_json::to_string(&msg).unwrap());
    stdin
        .write_all(msg_str.as_bytes())
        .await
        .map_err(|e| format!("Failed to write to codex stdin: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush codex stdin: {}", e))?;
    Ok(id)
}

async fn wait_for_response(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    expected_id: u64,
    session_id: &str,
    app_handle: &AppHandle,
) -> Result<Value, String> {
    loop {
        let line = lines
            .next_line()
            .await
            .map_err(|e| format!("Failed reading Codex stdout: {}", e))?;

        let line = match line {
            Some(l) => l,
            None => {
                return Err(format!(
                    "Codex app-server exited before responding to request id {}",
                    expected_id
                ))
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        let data: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => json!({ "raw": line }),
        };

        let event = SessionEvent {
            session_id: session_id.to_string(),
            event_type: "codex_message".to_string(),
            data: data.clone(),
        };
        let _ = app_handle.emit("session-event", &event);

        let response_id = data.get("id").and_then(|v| v.as_u64());
        if response_id != Some(expected_id) {
            continue;
        }

        if let Some(err) = data.get("error") {
            let msg = err
                .get("message")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| err.to_string());
            return Err(format!("Codex request {} failed: {}", expected_id, msg));
        }

        if let Some(result) = data.get("result") {
            return Ok(result.clone());
        }

        return Err(format!(
            "Codex response for request {} missing both result and error",
            expected_id
        ));
    }
}

pub async fn list_codex_threads(
    project_path: String,
    codex_bin: Option<String>,
) -> Result<Vec<CodexThreadSummary>, String> {
    let primary = run_codex_request(
        project_path.clone(),
        codex_bin.clone(),
        "thread/list",
        json!({
            "limit": 200,
            "sortKey": "updated_at",
            "archived": false,
        }),
    )
    .await;

    let result = match primary {
        Ok(result) => result,
        Err(primary_err) => {
            // Fallback for CLI/server versions that reject some list filters.
            run_codex_request(
                project_path,
                codex_bin,
                "thread/list",
                json!({
                    "limit": 200,
                }),
            )
            .await
            .map_err(|fallback_err| {
                format!(
                    "thread/list failed (primary: {}; fallback: {})",
                    primary_err, fallback_err
                )
            })?
        }
    };

    let data = if let Some(arr) = result.get("data").and_then(|v| v.as_array()) {
        arr
    } else if let Some(arr) = result.get("threads").and_then(|v| v.as_array()) {
        arr
    } else {
        return Err(format!("Invalid thread/list response: {}", result));
    };

    let mut threads = Vec::with_capacity(data.len());
    for thread in data {
        let id = thread
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("thread/list item missing id: {}", thread))?;

        let cwd = thread
            .get("cwd")
            .or_else(|| thread.get("projectPath"))
            .or_else(|| thread.get("project_path"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        let preview = thread
            .get("preview")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        let created_at_secs = thread
            .get("createdAt")
            .and_then(|v| v.as_i64())
            .unwrap_or_default();
        let updated_at_secs = thread
            .get("updatedAt")
            .and_then(|v| v.as_i64())
            .unwrap_or(created_at_secs);

        threads.push(CodexThreadSummary {
            thread_id: id.to_string(),
            preview,
            cwd,
            created_at_secs,
            updated_at_secs,
        });
    }

    Ok(threads)
}

pub async fn read_codex_thread_messages(
    project_path: String,
    codex_bin: Option<String>,
    thread_id: String,
    app_session_id: String,
) -> Result<Vec<ChatMessage>, String> {
    let result = run_codex_request(
        project_path,
        codex_bin,
        "thread/read",
        json!({
            "threadId": thread_id,
            "includeTurns": true,
        }),
    )
    .await?;

    let turns = result
        .get("thread")
        .and_then(|t| t.get("turns"))
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("Invalid thread/read response: {}", result))?;

    let mut messages: Vec<ChatMessage> = Vec::new();
    let mut ts = chrono::Utc::now().timestamp_millis() - 1_000_000;

    for turn in turns {
        let items = match turn.get("items").and_then(|v| v.as_array()) {
            Some(items) => items,
            None => continue,
        };

        for item in items {
            let item_type = match item.get("type").and_then(|v| v.as_str()) {
                Some(t) => t,
                None => continue,
            };

            if item_type == "userMessage" {
                let Some(content_items) = item.get("content").and_then(|v| v.as_array()) else {
                    continue;
                };

                let mut segments: Vec<String> = Vec::new();
                for c in content_items {
                    let input_type = c.get("type").and_then(|v| v.as_str()).unwrap_or_default();
                    match input_type {
                        "text" => {
                            if let Some(text) = c.get("text").and_then(|v| v.as_str()) {
                                if !text.trim().is_empty() {
                                    segments.push(text.to_string());
                                }
                            }
                        }
                        "image" => segments.push("[Image]".to_string()),
                        "localImage" | "local_image" => {
                            if let Some(path) = c.get("path").and_then(|v| v.as_str()) {
                                segments.push(format!("[Image: {}]", path));
                            } else {
                                segments.push("[Image]".to_string());
                            }
                        }
                        _ => {}
                    }
                }

                if segments.is_empty() {
                    continue;
                }

                ts += 1;
                messages.push(ChatMessage {
                    id: uuid::Uuid::new_v4().to_string(),
                    session_id: app_session_id.clone(),
                    role: MessageRole::User,
                    content: segments.join("\n"),
                    message_type: MessageType::Text,
                    created_at: ts,
                });
                continue;
            }

            if item_type == "agentMessage" {
                let Some(text) = item.get("text").and_then(|v| v.as_str()) else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }

                ts += 1;
                messages.push(ChatMessage {
                    id: uuid::Uuid::new_v4().to_string(),
                    session_id: app_session_id.clone(),
                    role: MessageRole::Assistant,
                    content: text.to_string(),
                    message_type: MessageType::Text,
                    created_at: ts,
                });
            }
        }
    }

    Ok(messages)
}

async fn run_codex_request(
    project_path: String,
    codex_bin: Option<String>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let bin = resolve_codex_bin(&codex_bin);
    let mut cmd = Command::new(&bin);
    cmd.arg("app-server")
        .current_dir(project_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn codex app-server: {}. Is '{}' installed and in PATH?", e, bin))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture codex stdout")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Failed to capture codex stderr")?;

    tokio::spawn(async move {
        let mut stderr_lines = BufReader::new(stderr).lines();
        while let Ok(Some(_)) = stderr_lines.next_line().await {}
    });

    let mut lines = BufReader::new(stdout).lines();
    let stdin = child.stdin.as_mut().ok_or("Failed to capture codex stdin")?;

    let init_id = send_codex_message(
        stdin,
        "initialize",
        json!({
            "clientInfo": {
                "name": "polycode",
                "title": "polyCode",
                "version": "0.1.0"
            }
        }),
    )
    .await?;
    timeout(
        Duration::from_secs(20),
        wait_for_response_noemit(&mut lines, init_id),
    )
    .await
    .map_err(|_| "Timed out waiting for Codex initialize response".to_string())??;

    let req_id = send_codex_message(stdin, method, params).await?;
    let result = timeout(
        Duration::from_secs(20),
        wait_for_response_noemit(&mut lines, req_id),
    )
    .await
    .map_err(|_| format!("Timed out waiting for Codex {} response", method))??;

    let _ = child.kill().await;
    let _ = child.wait().await;

    Ok(result)
}

async fn wait_for_response_noemit(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    expected_id: u64,
) -> Result<Value, String> {
    loop {
        let line = lines
            .next_line()
            .await
            .map_err(|e| format!("Failed reading Codex stdout: {}", e))?;

        let line = match line {
            Some(l) => l,
            None => {
                return Err(format!(
                    "Codex app-server exited before responding to request id {}",
                    expected_id
                ))
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        let data: Value =
            serde_json::from_str(&line).map_err(|e| format!("Invalid Codex JSON output: {}", e))?;

        let response_id = data.get("id").and_then(|v| v.as_u64());
        if response_id != Some(expected_id) {
            continue;
        }

        if let Some(err) = data.get("error") {
            let msg = err
                .get("message")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| err.to_string());
            return Err(format!("Codex request {} failed: {}", expected_id, msg));
        }

        if let Some(result) = data.get("result") {
            return Ok(result.clone());
        }

        return Err(format!(
            "Codex response for request {} missing both result and error",
            expected_id
        ));
    }
}

fn extract_thread_id(result: &Value) -> Option<String> {
    result
        .get("thread")
        .and_then(|t| t.get("id"))
        .and_then(|id| id.as_str())
        .map(|id| id.to_string())
        .or_else(|| {
            result
                .get("threadId")
                .and_then(|id| id.as_str())
                .map(|id| id.to_string())
        })
}

fn extract_codex_final_text(data: &Value) -> Option<String> {
    let method = data.get("method").and_then(|v| v.as_str())?;
    if method != "item/completed" {
        return None;
    }

    let item = data.get("params")?.get("item")?;
    let item_type = item.get("type").and_then(|v| v.as_str())?;
    if item_type != "agentMessage" {
        return None;
    }

    item.get("text")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn extract_codex_thread_name(data: &Value) -> Option<String> {
    let method = data.get("method").and_then(|v| v.as_str())?;
    if method != "thread/name/updated" {
        return None;
    }

    let params = data.get("params")?;
    let name = params
        .get("threadName")
        .or_else(|| params.get("thread_name"))
        .and_then(|v| v.as_str())?
        .trim()
        .to_string();

    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

async fn maybe_auto_rename_session(
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

    if session.provider != AIProvider::Codex {
        return Ok(false);
    }

    if !session.name.trim().eq_ignore_ascii_case("Codex Session") {
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
