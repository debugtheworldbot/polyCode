import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import type {
  Project,
  Session,
  ChatMessage,
  AppSettings,
  SessionEvent,
  CLIStatus,
  SlashCommand,
  GitStatusResponse,
  GitFileDiffResponse,
} from '../types';

// ─── Project Commands ───

export async function listProjects(): Promise<Project[]> {
  return invoke<Project[]>('list_projects');
}

export async function addProject(name: string, path: string): Promise<Project> {
  return invoke<Project>('add_project', { name, path });
}

export async function removeProject(projectId: string): Promise<void> {
  return invoke<void>('remove_project', { projectId });
}

export async function renameProject(projectId: string, newName: string): Promise<void> {
  return invoke<void>('rename_project', { projectId, newName });
}

// ─── Session Commands ───

export async function listSessions(projectId: string): Promise<Session[]> {
  return invoke<Session[]>('list_sessions', { projectId });
}

export async function createSession(
  projectId: string,
  provider: string,
  name?: string
): Promise<Session> {
  return invoke<Session>('create_session', { projectId, provider, name });
}

export async function removeSession(sessionId: string): Promise<void> {
  return invoke<void>('remove_session', { sessionId });
}

export async function renameSession(sessionId: string, newName: string): Promise<void> {
  return invoke<void>('rename_session', { sessionId, newName });
}

export async function updateSessionModel(
  sessionId: string,
  model: string | null
): Promise<void> {
  return invoke<void>('update_session_model', { sessionId, model });
}

export async function stopSession(sessionId: string): Promise<void> {
  return invoke<void>('stop_session', { sessionId });
}

export async function getAllSessions(): Promise<Session[]> {
  return invoke<Session[]>('get_all_sessions');
}

// ─── Message Commands ───

export async function getMessages(sessionId: string): Promise<ChatMessage[]> {
  return invoke<ChatMessage[]>('get_messages', { sessionId });
}

export async function sendMessage(
  sessionId: string,
  content: string
): Promise<ChatMessage> {
  return invoke<ChatMessage>('send_message', { sessionId, content });
}

// ─── Settings Commands ───

export async function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>('get_settings');
}

export async function updateSettings(settings: AppSettings): Promise<void> {
  return invoke<void>('update_settings', { settings });
}

export async function saveProviderSessionId(
  sessionId: string,
  providerSessionId: string
): Promise<void> {
  return invoke<void>('save_provider_session_id', { sessionId, providerSessionId });
}

// ─── Utility Commands ───

export async function checkCliAvailable(cliName: string): Promise<CLIStatus> {
  return invoke<CLIStatus>('check_cli_available', { cliName });
}

export async function listCodexSlashCommands(): Promise<SlashCommand[]> {
  return invoke<SlashCommand[]>('list_codex_slash_commands');
}

export async function getGitStatus(projectId: string): Promise<GitStatusResponse> {
  return invoke<GitStatusResponse>('get_git_status', { projectId });
}

export async function getGitFileDiff(
  projectId: string,
  filePath: string
): Promise<GitFileDiffResponse> {
  return invoke<GitFileDiffResponse>('get_git_file_diff', { projectId, filePath });
}

export async function stageGitFile(projectId: string, filePath: string): Promise<void> {
  return invoke<void>('git_stage_file', { projectId, filePath });
}

export async function unstageGitFile(projectId: string, filePath: string): Promise<void> {
  return invoke<void>('git_unstage_file', { projectId, filePath });
}

export async function discardGitFile(
  projectId: string,
  filePath: string,
  untracked: boolean
): Promise<void> {
  return invoke<void>('git_discard_file', { projectId, filePath, untracked });
}

export async function pickDirectory(): Promise<string | null> {
  const selection = await open({ directory: true, multiple: false });
  if (!selection || Array.isArray(selection)) {
    return null;
  }
  return selection;
}

export async function pickImages(): Promise<string[]> {
  const selection = await open({
    multiple: true,
    filters: [
      {
        name: 'Images',
        extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'],
      },
    ],
  });

  if (!selection) return [];
  if (Array.isArray(selection)) return selection;
  return [selection];
}

export async function savePastedImage(dataUrl: string): Promise<string> {
  return invoke<string>('save_pasted_image', { dataUrl });
}

export async function readImageDataUrl(path: string): Promise<string> {
  return invoke<string>('read_image_data_url', { path });
}

// ─── Event Listeners ───

export function onSessionEvent(
  callback: (event: SessionEvent) => void
): Promise<UnlistenFn> {
  return listen<SessionEvent>('session-event', (event) => {
    callback(event.payload);
  });
}
