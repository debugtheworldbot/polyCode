# polyCode

A Tauri v2 desktop app for orchestrating **OpenAI Codex**, **Anthropic Claude Code**, and **Google Gemini CLI** agents across local workspaces. Manage all your AI coding sessions in one place, organized by project.

![Tauri](https://img.shields.io/badge/Tauri-v2-blue)
![React](https://img.shields.io/badge/React-v19-61dafb)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)
![License](https://img.shields.io/badge/License-MIT-green)

## Features

### Multi-Provider AI Support
- **OpenAI Codex** — `codex app-server` JSON-RPC over stdio
- **Anthropic Claude Code** — `claude` CLI with streaming JSON output
- **Google Gemini CLI** — session sync and import from local Gemini files
- Color-coded badges for each provider

### Project-Based Organization
- Add local code repositories as projects
- All sessions are grouped under their associated project
- Quick switching between projects and sessions

### Session Management
- Create, rename, and delete sessions
- Each session maintains its own conversation history
- Real-time streaming of AI responses
- Stop/interrupt running sessions

### Modern UI
- macOS liquid glass vibrancy effect
- Light / Dark / System theme
- Multi-language (English & Chinese)
- Collapsible sidebar with context menus
- Keyboard shortcuts (Enter to send, Shift+Enter for new line)

## Architecture

```
polycode/
├── src/                    # Frontend (React + TypeScript)
│   ├── components/         # UI components
│   │   ├── sidebar/        # Project list, session list
│   │   ├── session/        # Message view, session header
│   │   ├── composer/       # Message input
│   │   ├── settings/       # Settings panel
│   │   └── common/         # Dialogs and shared components
│   ├── services/           # Tauri IPC wrapper
│   ├── store/              # Zustand state management
│   ├── types/              # TypeScript type definitions
│   ├── i18n/               # Internationalization
│   └── styles/             # Global CSS with Tailwind
├── src-tauri/              # Backend (Rust)
│   └── src/
│       ├── lib.rs          # Tauri app entry point
│       ├── commands.rs     # Tauri command handlers
│       ├── codex_adapter.rs    # Codex app-server adapter
│       ├── claude_adapter.rs   # Claude Code CLI adapter
│       ├── gemini_adapter.rs   # Gemini CLI adapter
│       ├── state.rs        # Application state
│       ├── storage.rs      # Data persistence
│       └── types.rs        # Rust type definitions
```

### How It Works

**Codex Integration:**
The app spawns a `codex app-server` child process per workspace and communicates via stdio using a JSON-RPC-like protocol. This is the same protocol used by the official Codex desktop app.

**Claude Code Integration:**
For each message, the app spawns a `claude -p "<prompt>" --output-format stream-json` process. Session continuity is maintained using `--resume <session_id>`. Streaming JSON events are parsed and displayed in real-time.

**Gemini CLI Integration:**
Syncs and imports sessions from Gemini CLI's local session files.

## Requirements

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- [Codex CLI](https://github.com/openai/codex) — `codex` in PATH
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — `claude` in PATH
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) — `gemini` in PATH (optional)

### Linux Additional Dependencies

```bash
sudo apt-get install libwebkit2gtk-4.1-dev build-essential libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
```

## Getting Started

### Install Dependencies

```bash
npm install
```

### Development

```bash
npm run tauri dev
```

### Build

```bash
npm run tauri build
```

Build artifacts will be in `src-tauri/target/release/bundle/`.

## Configuration

Settings are accessible from the sidebar gear icon:

| Setting | Description |
|---------|-------------|
| **Theme** | Light, Dark, or System |
| **Language** | English, Chinese, or System |
| **Codex Binary Path** | Custom path to `codex` binary (leave empty for default) |
| **Claude Binary Path** | Custom path to `claude` binary (leave empty for default) |
| **Gemini Binary Path** | Custom path to `gemini` binary (leave empty for default) |

Data is persisted to the OS-specific app data directory:
- **Linux:** `~/.local/share/polycode/`
- **macOS:** `~/Library/Application Support/polycode/`
- **Windows:** `%APPDATA%/polycode/`

## Inspired By

This project is inspired by [CodexMonitor](https://github.com/Dimillian/CodexMonitor) by Thomas Ricouard, extending its concepts to support multiple AI providers.

## License

MIT
