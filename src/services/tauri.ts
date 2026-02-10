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

// ─── Utility Commands ───

export async function checkCliAvailable(cliName: string): Promise<CLIStatus> {
  return invoke<CLIStatus>('check_cli_available', { cliName });
}

export async function pickDirectory(): Promise<string | null> {
  const selection = await open({ directory: true, multiple: false });
  if (!selection || Array.isArray(selection)) {
    return null;
  }
  return selection;
}

// ─── Event Listeners ───

export function onSessionEvent(
  callback: (event: SessionEvent) => void
): Promise<UnlistenFn> {
  return listen<SessionEvent>('session-event', (event) => {
    callback(event.payload);
  });
}
