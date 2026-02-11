# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**polyCode** — a Tauri v2 desktop app for orchestrating OpenAI Codex, Anthropic Claude Code, and Google Gemini CLI agents across local workspaces. Manage AI coding sessions organized by project.

## Commands

```bash
npm install              # Install frontend dependencies
npm run tauri dev        # Development (starts Vite + Tauri)
npm run tauri build      # Production build → src-tauri/target/release/bundle/
npm run build            # Frontend only (tsc + vite)
npm run lint             # ESLint
```

## Architecture

**Frontend** (React 19 + TypeScript + Tailwind CSS v4 + Vite):
- `src/store/index.ts` — Zustand store, central state management. Contains all event parsing logic for Codex JSON-RPC and Claude streaming events.
- `src/services/tauri.ts` — Thin wrapper around `@tauri-apps/api/core` invoke calls. All IPC with backend goes through here.
- `src/types/index.ts` — Shared TypeScript types mirroring Rust types.
- `src/i18n/index.ts` — i18n (English + Chinese).
- `src/components/` — sidebar (project tree, session list), session (message view, header), composer, settings, git panel.

**Backend** (Rust, Tauri v2):
- `src-tauri/src/lib.rs` — App entry, plugin registration, liquid glass effect (macOS).
- `src-tauri/src/commands.rs` — All `#[tauri::command]` handlers: project/session CRUD, message sending, git operations, settings.
- `src-tauri/src/codex_adapter.rs` — Spawns `codex app-server` child process, communicates via stdio JSON-RPC.
- `src-tauri/src/claude_adapter.rs` — Spawns `claude -p` per message with `--output-format stream-json`, uses `--resume` for session continuity.
- `src-tauri/src/gemini_adapter.rs` — Gemini CLI session sync/import.
- `src-tauri/src/storage.rs` — JSON file persistence to OS app data dir.
- `src-tauri/src/state.rs` — `AppState` with tokio Mutex for data and active sessions.
- `src-tauri/src/types.rs` — Rust types (must stay in sync with `src/types/index.ts`).

## Key Patterns

- **IPC**: Frontend calls `invoke<T>('command_name', { params })` → Rust `#[tauri::command]` handlers. Backend emits events via `app.emit("session-event", SessionEvent)` → frontend listens with `listen<SessionEvent>`.
- **Provider adapters**: Codex uses a persistent child process per session; Claude spawns a new process per message. Both stream events to the frontend via Tauri events.
- **Session sync**: When listing sessions, the app syncs with provider-native session stores (Codex threads, Claude CLI sessions, Gemini local files) and imports them.
- **Types must match**: `src-tauri/src/types.rs` and `src/types/index.ts` define the same data structures. Keep them in sync when modifying.
- **macOS**: Uses `titleBarStyle: Overlay`, `transparent: true`, and `tauri-plugin-liquid-glass` for vibrancy effects. `macOSPrivateApi: true` is required.

## 中文回复，言简意赅。如无必要，勿增实体。
