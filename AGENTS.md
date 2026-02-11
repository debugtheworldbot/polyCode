# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the React + TypeScript UI. Keep feature code grouped by domain:
- `src/components/` for UI (`sidebar/`, `session/`, `composer/`, `settings/`, `common/`, `git/`)
- `src/store/` for Zustand state
- `src/services/` for Tauri IPC wrappers
- `src/types/`, `src/constants/`, `src/i18n/`, `src/styles/` for shared definitions and app-wide resources

`src-tauri/` is the Rust backend:
- `src-tauri/src/commands.rs` exposes Tauri commands
- adapter modules (`codex_adapter.rs`, `claude_adapter.rs`, `gemini_adapter.rs`) handle provider integration
- `state.rs`, `storage.rs`, `types.rs` define runtime state and persistence

Generated outputs include `dist/` and `src-tauri/target/`.

## Build, Test, and Development Commands
- `npm install` installs frontend dependencies.
- `npm run dev` starts the Vite web UI only.
- `npm run tauri:dev` runs the desktop app (frontend + Rust backend).
- `npm run build` performs TypeScript build checks and bundles frontend assets.
- `npm run tauri:build` creates release desktop bundles.
- `npm run lint` runs ESLint across `*.ts`/`*.tsx`.
- `cargo check --manifest-path src-tauri/Cargo.toml` validates Rust code quickly.

## Coding Style & Naming Conventions
TypeScript is strict-mode (`tsconfig.app.json`) and linted with ESLint (`eslint.config.js`). Use functional React components and keep side effects inside hooks. File naming conventions:
- Components: `PascalCase.tsx` (example: `SessionHeader.tsx`)
- Utilities/services/store methods: `camelCase`
- Rust modules/files: `snake_case.rs`

Follow the existing style in touched files; do not mix large formatting-only changes with feature work.

UI rule for icon buttons:
- For icon-only controls (including `header-btn`, `icon-btn`, `git-icon-btn`, `git-mini-btn`, `btn-icon`), keep default background transparent.
- Only show background on hover, and use the unified hover color `var(--color-sidebar-hover)`.

## Testing Guidelines
There is no dedicated JS test runner configured yet. Before opening a PR, run:
1. `npm run lint`
2. `npm run build`
3. `cargo check --manifest-path src-tauri/Cargo.toml`

For new logic-heavy code, add small, focused tests near the implementation when practical (Rust unit tests in `#[cfg(test)]` modules).

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit prefixes like `feat:`, `fix:`, and `refactor:`. Keep messages imperative and scoped to one change.

PRs should include:
1. Clear summary of behavior changes
2. Validation steps/commands run
3. Screenshots or short recordings for UI updates
4. Linked issue or task reference when available

## Security & Configuration Tips
The app executes local CLI tools (`codex`, `claude`). Do not hardcode user-specific paths or commit credentials, tokens, or local data files.
