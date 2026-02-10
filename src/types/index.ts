export type AIProvider = 'codex' | 'claude' | 'gemini';

export interface Project {
  id: string;
  name: string;
  path: string;
  created_at: number;
}

export interface Session {
  id: string;
  project_id: string;
  name: string;
  provider: AIProvider;
  model?: string | null;
  created_at: number;
  updated_at: number;
  provider_session_id?: string | null;
}

export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageType = 'text' | 'tool' | 'diff' | 'error' | 'reasoning';

export interface ChatMessage {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  message_type: MessageType;
  created_at: number;
}

export interface AppSettings {
  codex_bin: string | null;
  claude_bin: string | null;
  theme: string;
  language: string;
}

export interface SessionEvent {
  session_id: string;
  event_type: string;
  data: Record<string, unknown>;
}

export interface CLIStatus {
  available: boolean;
  path: string | null;
}

export interface GitFileStatus {
  path: string;
  old_path: string | null;
  index_status: string;
  worktree_status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatusResponse {
  is_git_repo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

export interface GitFileDiffResponse {
  staged_patch: string | null;
  unstaged_patch: string | null;
}

export type ThemeMode = 'light' | 'dark' | 'system';
export type Language = 'en' | 'zh' | 'system';
