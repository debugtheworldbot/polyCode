import { create } from 'zustand';
import type { Project, Session, ChatMessage, AppSettings, SessionEvent, AIProvider } from '../types';
import * as api from '../services/tauri';
import { setLanguage } from '../i18n';

type JsonRecord = Record<string, unknown>;
type InsertMode = 'append' | 'replace_or_create' | 'new';

interface ParsedEventMessage {
  role: ChatMessage['role'];
  messageType: ChatMessage['message_type'];
  content: string;
  mode: InsertMode;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function createMessage(sessionId: string, parsed: ParsedEventMessage): ChatMessage {
  return {
    id: crypto.randomUUID(),
    session_id: sessionId,
    role: parsed.role,
    content: parsed.content,
    message_type: parsed.messageType,
    created_at: Date.now(),
  };
}

function mergeMessage(
  existing: ChatMessage[],
  sessionId: string,
  parsed: ParsedEventMessage
): ChatMessage[] {
  if (!parsed.content) return existing;

  const last = existing[existing.length - 1];
  const isSameKind =
    last &&
    last.role === parsed.role &&
    last.message_type === parsed.messageType;

  if (parsed.mode === 'append') {
    if (isSameKind) {
      const updated = [...existing];
      updated[updated.length - 1] = {
        ...last,
        content: `${last.content}${parsed.content}`,
      };
      return updated;
    }
    return [...existing, createMessage(sessionId, parsed)];
  }

  if (parsed.mode === 'replace_or_create') {
    if (isSameKind) {
      if (last.content === parsed.content) return existing;
      if (parsed.content.includes(last.content)) {
        const updated = [...existing];
        updated[updated.length - 1] = { ...last, content: parsed.content };
        return updated;
      }
      if (last.content.includes(parsed.content)) return existing;
      return [...existing, createMessage(sessionId, parsed)];
    }
    return [...existing, createMessage(sessionId, parsed)];
  }

  return [...existing, createMessage(sessionId, parsed)];
}

function parseClaudeDelta(data: JsonRecord): string | null {
  const evt = isRecord(data.event) ? data.event : null;
  if (!evt) return null;

  const delta = isRecord(evt.delta) ? evt.delta : null;
  if (!delta) return null;

  if (delta.type === 'text_delta') {
    return asString(delta.text);
  }
  return null;
}

function parseCodexEvent(data: JsonRecord): ParsedEventMessage | null {
  const rpcError = isRecord(data.error) ? data.error : null;
  if (rpcError) {
    return {
      role: 'system',
      messageType: 'error',
      content: asString(rpcError.message) || JSON.stringify(rpcError),
      mode: 'new',
    };
  }

  const method = asString(data.method);
  if (!method) return null;

  const params = isRecord(data.params) ? data.params : null;
  if (!params) return null;

  if (method === 'item/agentMessage/delta') {
    const delta = asString(params.delta);
    if (!delta) return null;
    return {
      role: 'assistant',
      messageType: 'text',
      content: delta,
      mode: 'append',
    };
  }

  if (method === 'item/completed') {
    const item = isRecord(params.item) ? params.item : null;
    if (!item) return null;

    const itemType = asString(item.type);
    if (!itemType) return null;

    if (itemType === 'agentMessage') {
      const text = asString(item.text);
      if (!text) return null;
      return {
        role: 'assistant',
        messageType: 'text',
        content: text,
        mode: 'replace_or_create',
      };
    }

    if (itemType === 'commandExecution') {
      const command = asString(item.command) || 'command';
      const exitCode = asNumber(item.exitCode);
      const durationMs = asNumber(item.durationMs);
      const status = asString(item.status);
      const details: string[] = [];
      if (exitCode !== null) details.push(`exit ${exitCode}`);
      else if (status) details.push(status);
      if (durationMs !== null) details.push(`${Math.round(durationMs)}ms`);

      return {
        role: 'assistant',
        messageType: 'tool',
        content: details.length > 0
          ? `[Command] ${command} (${details.join(', ')})`
          : `[Command] ${command}`,
        mode: 'new',
      };
    }

    if (itemType === 'fileChange') {
      const changes = Array.isArray(item.changes) ? item.changes.length : 0;
      const status = asString(item.status);
      return {
        role: 'assistant',
        messageType: 'diff',
        content: status
          ? `[Files] ${changes} change${changes === 1 ? '' : 's'} (${status})`
          : `[Files] ${changes} change${changes === 1 ? '' : 's'}`,
        mode: 'new',
      };
    }

    if (itemType === 'mcpToolCall') {
      const server = asString(item.server) || 'mcp';
      const tool = asString(item.tool) || 'tool';
      const status = asString(item.status) || 'completed';
      return {
        role: 'assistant',
        messageType: 'tool',
        content: `[MCP] ${server}/${tool} (${status})`,
        mode: 'new',
      };
    }

    return null;
  }

  if (method === 'error') {
    const err = isRecord(params.error) ? params.error : null;
    return {
      role: 'system',
      messageType: 'error',
      content: err ? asString(err.message) || JSON.stringify(err) : 'Codex error',
      mode: 'new',
    };
  }

  if (method === 'turn/completed') {
    const turn = isRecord(params.turn) ? params.turn : null;
    if (!turn) return null;

    if (asString(turn.status) === 'failed') {
      const err = isRecord(turn.error) ? turn.error : null;
      return {
        role: 'system',
        messageType: 'error',
        content: err ? asString(err.message) || JSON.stringify(err) : 'Codex turn failed',
        mode: 'new',
      };
    }
  }

  return null;
}

interface AppStore {
  // ─── State ───
  projects: Project[];
  sessions: Session[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  messages: Record<string, ChatMessage[]>;
  settings: AppSettings;
  isSending: boolean;
  showSettings: boolean;
  showNewProjectDialog: boolean;
  showNewSessionDialog: boolean;
  sidebarCollapsed: boolean;

  // ─── Actions ───
  initialize: () => Promise<void>;
  loadProjects: () => Promise<void>;
  addProject: (name: string, path: string) => Promise<void>;
  removeProject: (projectId: string) => Promise<void>;
  renameProject: (projectId: string, newName: string) => Promise<void>;
  setActiveProject: (projectId: string | null) => Promise<void>;

  loadSessions: (projectId: string) => Promise<void>;
  createSession: (projectId: string, provider: AIProvider, name?: string) => Promise<void>;
  removeSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, newName: string) => Promise<void>;
  setActiveSession: (sessionId: string | null) => Promise<void>;
  stopSession: (sessionId: string) => Promise<void>;

  loadMessages: (sessionId: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  handleSessionEvent: (event: SessionEvent) => void;

  loadSettings: () => Promise<void>;
  updateSettings: (settings: AppSettings) => Promise<void>;

  setShowSettings: (show: boolean) => void;
  setShowNewProjectDialog: (show: boolean) => void;
  setShowNewSessionDialog: (show: boolean) => void;
  toggleSidebar: () => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
  // ─── Initial State ───
  projects: [],
  sessions: [],
  activeProjectId: null,
  activeSessionId: null,
  messages: {},
  settings: {
    codex_bin: null,
    claude_bin: null,
    theme: 'light',
    language: 'system',
  },
  isSending: false,
  showSettings: false,
  showNewProjectDialog: false,
  showNewSessionDialog: false,
  sidebarCollapsed: false,

  // ─── Initialize ───
  initialize: async () => {
    try {
      await get().loadSettings();
      await get().loadProjects();
    } catch (e) {
      console.error('Failed to initialize:', e);
    }
  },

  // ─── Project Actions ───
  loadProjects: async () => {
    try {
      const projects = await api.listProjects();
      set({ projects });
    } catch (e) {
      console.error('Failed to load projects:', e);
    }
  },

  addProject: async (name: string, path: string) => {
    try {
      const project = await api.addProject(name, path);
      set((state) => ({ projects: [...state.projects, project] }));
      await get().setActiveProject(project.id);
    } catch (e) {
      console.error('Failed to add project:', e);
      throw e;
    }
  },

  removeProject: async (projectId: string) => {
    try {
      await api.removeProject(projectId);
      set((state) => {
        const projects = state.projects.filter((p) => p.id !== projectId);
        const activeProjectId =
          state.activeProjectId === projectId ? null : state.activeProjectId;
        return { projects, activeProjectId, sessions: activeProjectId ? state.sessions : [] };
      });
    } catch (e) {
      console.error('Failed to remove project:', e);
    }
  },

  renameProject: async (projectId: string, newName: string) => {
    try {
      await api.renameProject(projectId, newName);
      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === projectId ? { ...p, name: newName } : p
        ),
      }));
    } catch (e) {
      console.error('Failed to rename project:', e);
    }
  },

  setActiveProject: async (projectId: string | null) => {
    set({ activeProjectId: projectId, activeSessionId: null, sessions: [] });
    if (projectId) {
      await get().loadSessions(projectId);
    }
  },

  // ─── Session Actions ───
  loadSessions: async (projectId: string) => {
    try {
      const sessions = await api.listSessions(projectId);
      set({ sessions });
    } catch (e) {
      console.error('Failed to load sessions:', e);
    }
  },

  createSession: async (projectId: string, provider: AIProvider, name?: string) => {
    try {
      const session = await api.createSession(projectId, provider, name);
      set((state) => ({ sessions: [...state.sessions, session] }));
      await get().setActiveSession(session.id);
    } catch (e) {
      console.error('Failed to create session:', e);
      throw e;
    }
  },

  removeSession: async (sessionId: string) => {
    try {
      await api.removeSession(sessionId);
      set((state) => {
        const sessions = state.sessions.filter((s) => s.id !== sessionId);
        const activeSessionId =
          state.activeSessionId === sessionId ? null : state.activeSessionId;
        return { sessions, activeSessionId };
      });
    } catch (e) {
      console.error('Failed to remove session:', e);
    }
  },

  renameSession: async (sessionId: string, newName: string) => {
    try {
      await api.renameSession(sessionId, newName);
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, name: newName } : s
        ),
      }));
    } catch (e) {
      console.error('Failed to rename session:', e);
    }
  },

  setActiveSession: async (sessionId: string | null) => {
    set({ activeSessionId: sessionId });
    if (sessionId) {
      await get().loadMessages(sessionId);
    }
  },

  stopSession: async (sessionId: string) => {
    try {
      await api.stopSession(sessionId);
    } catch (e) {
      console.error('Failed to stop session:', e);
    }
  },

  // ─── Message Actions ───
  loadMessages: async (sessionId: string) => {
    try {
      const messages = await api.getMessages(sessionId);
      set((state) => ({
        messages: { ...state.messages, [sessionId]: messages },
      }));
    } catch (e) {
      console.error('Failed to load messages:', e);
    }
  },

  sendMessage: async (content: string) => {
    const { activeSessionId } = get();
    if (!activeSessionId || !content.trim()) return;

    set({ isSending: true });
    try {
      await api.sendMessage(activeSessionId, content);
    } catch (e) {
      console.error('Failed to send message:', e);
    } finally {
      set({ isSending: false });
    }
  },

  handleSessionEvent: (event: SessionEvent) => {
    const { session_id, event_type, data } = event;

    if (event_type === 'user_message') {
      const msg = data as unknown as ChatMessage;
      set((state) => {
        const existing = state.messages[session_id] || [];
        // Avoid duplicates
        if (existing.some((m) => m.id === msg.id)) return state;
        return {
          messages: { ...state.messages, [session_id]: [...existing, msg] },
        };
      });
      return;
    }

    if (event_type === 'session_renamed') {
      const newName = asString(data.name);
      if (!newName) return;

      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === session_id ? { ...s, name: newName } : s
        ),
      }));
      return;
    }

    if (event_type === 'codex_message') {
      const parsed = parseCodexEvent(data);
      if (!parsed) return;

      set((state) => {
        const existing = state.messages[session_id] || [];
        const updated = mergeMessage(existing, session_id, parsed);
        if (updated === existing) return state;
        return { messages: { ...state.messages, [session_id]: updated } };
      });
      return;
    }

    if (event_type === 'claude_stream') {
      const delta = parseClaudeDelta(data);
      if (!delta) return;

      set((state) => {
        const existing = state.messages[session_id] || [];
        const updated = mergeMessage(existing, session_id, {
          role: 'assistant',
          messageType: 'text',
          content: delta,
          mode: 'append',
        });
        if (updated === existing) return state;
        return { messages: { ...state.messages, [session_id]: updated } };
      });
      return;
    }

    // Handle Claude result (final message)
    if (event_type === 'claude_result') {
      const result = asString(data.result) || '';
      if (result) {
        set((state) => {
          const existing = state.messages[session_id] || [];
          const updated = mergeMessage(existing, session_id, {
            role: 'assistant',
            messageType: 'text',
            content: result,
            mode: 'replace_or_create',
          });
          if (updated === existing) return state;
          return {
            messages: { ...state.messages, [session_id]: updated },
          };
        });
      }
      return;
    }

    // Handle errors
    if (event_type === 'codex_error' || event_type === 'claude_error') {
      const errorMsg = asString(data.message) || 'Unknown error';
      set((state) => {
        const existing = state.messages[session_id] || [];
        const updated = mergeMessage(existing, session_id, {
          role: 'system',
          messageType: 'error',
          content: errorMsg,
          mode: 'new',
        });
        return {
          messages: { ...state.messages, [session_id]: updated },
        };
      });
      return;
    }
  },

  // ─── Settings Actions ───
  loadSettings: async () => {
    try {
      const settings = await api.getSettings();
      set({ settings });
      setLanguage(settings.language || 'system');
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  },

  updateSettings: async (settings: AppSettings) => {
    try {
      await api.updateSettings(settings);
      set({ settings });
      setLanguage(settings.language || 'system');
    } catch (e) {
      console.error('Failed to update settings:', e);
      throw e;
    }
  },

  // ─── UI Actions ───
  setShowSettings: (show: boolean) => set({ showSettings: show }),
  setShowNewProjectDialog: (show: boolean) => set({ showNewProjectDialog: show }),
  setShowNewSessionDialog: (show: boolean) => set({ showNewSessionDialog: show }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
}));
