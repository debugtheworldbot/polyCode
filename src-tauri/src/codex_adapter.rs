use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::types::SessionEvent;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

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
    app_handle: AppHandle,
) -> Result<tokio::process::Child, String> {
    let bin = resolve_codex_bin(&codex_bin);

    let mut cmd = Command::new(&bin);
    cmd.arg("app-server")
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

    let sid = session_id.clone();
    let handle = app_handle.clone();

    // Read stdout (JSONL from app-server)
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

            let event = SessionEvent {
                session_id: sid.clone(),
                event_type: "codex_message".to_string(),
                data,
            };

            let _ = handle.emit("session-event", &event);
        }
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
                event_type: "codex_error".to_string(),
                data: json!({ "message": line }),
            };
            let _ = handle2.emit("session-event", &event);
        }
    });

    // Send initialize request
    if let Some(ref mut stdin) = child.stdin {
        let init_msg = json!({
            "id": NEXT_ID.fetch_add(1, Ordering::SeqCst),
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "codex_hub",
                    "title": "CodexHub",
                    "version": "0.1.0"
                },
                "capabilities": {
                    "experimentalApi": true
                }
            }
        });
        let msg_str = format!("{}\n", serde_json::to_string(&init_msg).unwrap());
        let _ = stdin.write_all(msg_str.as_bytes()).await;
        let _ = stdin.flush().await;
    }

    Ok(child)
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
