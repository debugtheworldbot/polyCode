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

function normalizeItemType(value: string): string {
  return value.replace(/[_-]/g, '').toLowerCase();
}

function firstNonEmptyString(values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function compactText(value: string, max = 120): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function parseCodexLiveStatus(data: JsonRecord): string | null | undefined {
  const method = asString(data.method);
  if (!method) return undefined;

  const params = isRecord(data.params) ? data.params : null;

  if (method === 'turn/completed') return null;
  if (method === 'turn/started') return 'Thinking';
  if (method === 'error') return 'Error';

  const turnLike = method.startsWith('turn/');
  if (turnLike && params) {
    const direct = firstNonEmptyString([
      params.title,
      params.statusText,
      params.status_text,
      params.message,
      params.summary,
      params.status,
    ]);
    if (direct) return compactText(direct);
  }

  if (!params) return undefined;
  if (method !== 'item/started' && method !== 'item/updated' && method !== 'item/in_progress') {
    return undefined;
  }

  const item = isRecord(params.item) ? params.item : null;
  if (!item) return undefined;

  const explicit = firstNonEmptyString([
    item.title,
    item.statusText,
    item.status_text,
    item.message,
    item.description,
    item.summary,
    params.title,
    params.statusText,
    params.status_text,
    params.message,
  ]);
  if (explicit) return compactText(explicit);

  const itemType = asString(item.type);
  if (!itemType) return 'Thinking';

  const normalizedType = normalizeItemType(itemType);
  if (normalizedType === 'commandexecution') {
    const argv = Array.isArray(item.argv)
      ? item.argv.filter((v): v is string => typeof v === 'string')
      : [];
    const command = asString(item.command) || (argv.length > 0 ? argv.join(' ') : null);
    if (command) return compactText(`Running ${command}`);
    return 'Running command';
  }

  if (normalizedType === 'filechange') {
    return 'Editing files';
  }

  if (normalizedType === 'mcptoolcall') {
    const server = asString(item.server);
    const tool = asString(item.tool);
    if (server && tool) return `Using ${server}/${tool}`;
    if (tool) return `Using ${tool}`;
    return 'Using MCP tool';
  }

  if (normalizedType === 'agentmessage') {
    return 'Writing response';
  }

  return 'Thinking';
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
      const updated = [...existing];
      updated[updated.length - 1] = { ...last, content: parsed.content };
      return updated;
    }
    return [...existing, createMessage(sessionId, parsed)];
  }

  // Guard against duplicated "new" events from provider stream.
  if (isSameKind && last.content === parsed.content) {
    return existing;
  }

  if (parsed.messageType === 'tool') {
    const recent = existing.slice(-8);
    const hasRecentDuplicate = recent.some(
      (msg) =>
        msg.role === parsed.role &&
        msg.message_type === parsed.messageType &&
        msg.content === parsed.content
    );
    if (hasRecentDuplicate) return existing;
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
    const normalizedType = normalizeItemType(itemType);

    if (normalizedType === 'agentmessage') {
      const text = asString(item.text);
      if (!text) return null;
      return {
        role: 'assistant',
        messageType: 'text',
        content: text,
        mode: 'replace_or_create',
      };
    }

    if (normalizedType === 'commandexecution') {
      const argv = Array.isArray(item.argv)
        ? item.argv.filter((v): v is string => typeof v === 'string')
        : [];
      const command = asString(item.command) || (argv.length > 0 ? argv.join(' ') : 'command');
      const exitCode = asNumber(item.exitCode) ?? asNumber(item.exit_code);
      const durationMs = asNumber(item.durationMs) ?? asNumber(item.duration_ms);
      const status = asString(item.status);
      const details: string[] = [];
      if (exitCode !== null) details.push(`exit ${exitCode}`);
      else if (status) details.push(status);
      if (durationMs !== null) details.push(`${Math.round(durationMs)}ms`);

      return {
        role: 'assistant',
        messageType: 'tool',
        content: details.length > 0
          ? `Ran \`${command}\` (${details.join(', ')})`
          : `Ran \`${command}\``,
        mode: 'new',
      };
    }

    if (normalizedType === 'filechange') {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const status = asString(item.status);
      const paths = changes
        .map((change) => {
          if (!isRecord(change)) return null;
          return asString(change.path) || asString(change.filePath) || asString(change.file);
        })
        .filter((path): path is string => !!path && path.trim().length > 0);

      let summary: string;
      if (paths.length === 1) {
        summary = `Edited \`${paths[0]}\``;
      } else if (paths.length > 1) {
        const shown = paths.slice(0, 2);
        const remaining = paths.length - shown.length;
        summary = remaining > 0
          ? `Edited \`${shown.join('`, `')}\` +${remaining} files`
          : `Edited \`${shown.join('`, `')}\``;
      } else {
        const count = changes.length;
        summary = count > 0
          ? `Edited ${count} file${count === 1 ? '' : 's'}`
          : 'Edited files';
      }

      return {
        role: 'assistant',
        messageType: 'tool',
        content: status
          ? `${summary} (${status})`
          : summary,
        mode: 'new',
      };
    }

    if (normalizedType === 'mcptoolcall') {
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
  sessionsByProject: Record<string, Session[]>;
  expandedProjects: Record<string, boolean>;
  sidebarWidth: number;
  activeProjectId: string | null;
  activeSessionId: string | null;
  messages: Record<string, ChatMessage[]>;
  queuedMessages: Record<string, string[]>;
  refreshingSessions: Record<string, boolean>;
  liveStatusBySession: Record<string, string>;
  activeTurnStartedAt: Record<string, number>;
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
  loadAllSessions: () => Promise<void>;
  createSession: (projectId: string, provider: AIProvider, name?: string) => Promise<void>;
  removeSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, newName: string) => Promise<void>;
  setSessionModel: (sessionId: string, model: string | null) => Promise<void>;
  setActiveSession: (sessionId: string | null) => Promise<void>;
  stopSession: (sessionId: string) => Promise<void>;
  toggleProjectExpanded: (projectId: string) => void;
  setSidebarWidth: (width: number) => void;

  loadMessages: (sessionId: string) => Promise<void>;
  refreshSession: (sessionId: string) => Promise<void>;
  sendMessageToSession: (sessionId: string, content: string) => Promise<void>;
  flushQueuedMessages: (sessionId: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  handleSessionEvent: (event: SessionEvent) => void;

  loadSettings: () => Promise<void>;
  updateSettings: (settings: AppSettings) => Promise<void>;

  setShowSettings: (show: boolean) => void;
  setShowNewProjectDialog: (show: boolean) => void;
  setShowNewSessionDialog: (show: boolean) => void;
  toggleSidebar: () => void;
}

function loadPersisted<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch { /* ignore */ }
  return fallback;
}

function savePersisted(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

export const useAppStore = create<AppStore>((set, get) => ({
  // ─── Initial State ───
  projects: [],
  sessions: [],
  sessionsByProject: {},
  expandedProjects: loadPersisted<Record<string, boolean>>('expandedProjects', {}),
  sidebarWidth: loadPersisted<number>('sidebarWidth', 260),
  activeProjectId: null,
  activeSessionId: null,
  messages: {},
  queuedMessages: {},
  refreshingSessions: {},
  liveStatusBySession: {},
  activeTurnStartedAt: {},
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
      const currentActive = get().activeProjectId;
      const hasCurrentActive = currentActive
        ? projects.some((project) => project.id === currentActive)
        : false;
      const nextActiveProjectId = hasCurrentActive
        ? currentActive
        : (projects[0]?.id ?? null);

      set({
        projects,
        activeProjectId: nextActiveProjectId,
        activeSessionId: null,
        sessions: [],
      });

      await get().loadAllSessions();

      if (nextActiveProjectId) {
        await get().loadSessions(nextActiveProjectId);
      }
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
        const sessionsByProject = { ...state.sessionsByProject };
        delete sessionsByProject[projectId];
        const expandedProjects = { ...state.expandedProjects };
        delete expandedProjects[projectId];
        savePersisted('expandedProjects', expandedProjects);
        return { projects, activeProjectId, sessions: activeProjectId ? state.sessions : [], sessionsByProject, expandedProjects };
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
    set((state) => {
      const expandedProjects = projectId
        ? { ...state.expandedProjects, [projectId]: true }
        : state.expandedProjects;
      savePersisted('expandedProjects', expandedProjects);
      return { activeProjectId: projectId, activeSessionId: null, sessions: [], expandedProjects };
    });
    if (projectId) {
      await get().loadSessions(projectId);
    }
  },

  // ─── Session Actions ───
  loadSessions: async (projectId: string) => {
    try {
      const sessions = await api.listSessions(projectId);
      set((state) => ({
        sessions,
        sessionsByProject: { ...state.sessionsByProject, [projectId]: sessions },
      }));
    } catch (e) {
      console.error('Failed to load sessions:', e);
    }
  },

  loadAllSessions: async () => {
    try {
      const allSessions = await api.getAllSessions();
      const grouped: Record<string, Session[]> = {};
      for (const s of allSessions) {
        if (!grouped[s.project_id]) grouped[s.project_id] = [];
        grouped[s.project_id].push(s);
      }
      set({ sessionsByProject: grouped });
    } catch (e) {
      console.error('Failed to load all sessions:', e);
    }
  },

  createSession: async (projectId: string, provider: AIProvider, name?: string) => {
    try {
      const session = await api.createSession(projectId, provider, name);
      set((state) => ({
        sessions: [...state.sessions, session],
        sessionsByProject: {
          ...state.sessionsByProject,
          [projectId]: [...(state.sessionsByProject[projectId] || []), session],
        },
      }));
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
        const sessionsByProject = { ...state.sessionsByProject };
        for (const pid of Object.keys(sessionsByProject)) {
          sessionsByProject[pid] = sessionsByProject[pid].filter((s) => s.id !== sessionId);
        }
        return { sessions, activeSessionId, sessionsByProject };
      });
    } catch (e) {
      console.error('Failed to remove session:', e);
    }
  },

  renameSession: async (sessionId: string, newName: string) => {
    try {
      await api.renameSession(sessionId, newName);
      const mapName = (s: Session) => s.id === sessionId ? { ...s, name: newName } : s;
      set((state) => {
        const sessionsByProject = { ...state.sessionsByProject };
        for (const pid of Object.keys(sessionsByProject)) {
          sessionsByProject[pid] = sessionsByProject[pid].map(mapName);
        }
        return {
          sessions: state.sessions.map(mapName),
          sessionsByProject,
        };
      });
    } catch (e) {
      console.error('Failed to rename session:', e);
    }
  },

  setSessionModel: async (sessionId: string, model: string | null) => {
    const normalized = model && model.trim().length > 0 ? model.trim() : null;
    try {
      await api.updateSessionModel(sessionId, normalized);
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, model: normalized, updated_at: Date.now() } : s
        ),
      }));
    } catch (e) {
      console.error('Failed to update session model:', e);
      throw e;
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
    set({ isSending: false });
    set((state) => {
      const nextStatus = { ...state.liveStatusBySession };
      const nextStart = { ...state.activeTurnStartedAt };
      delete nextStatus[sessionId];
      delete nextStart[sessionId];
      return {
        liveStatusBySession: nextStatus,
        activeTurnStartedAt: nextStart,
      };
    });
    void get().flushQueuedMessages(sessionId);
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

  refreshSession: async (sessionId: string) => {
    const session = get().sessions.find((s) => s.id === sessionId);
    if (!session) return;

    set((state) => ({
      refreshingSessions: {
        ...state.refreshingSessions,
        [sessionId]: true,
      },
    }));

    try {
      await get().loadSessions(session.project_id);
      const messages = await api.getMessages(sessionId);
      set((state) => ({
        messages: { ...state.messages, [sessionId]: messages },
      }));
    } catch (e) {
      console.error('Failed to refresh session:', e);
    } finally {
      set((state) => {
        const next = { ...state.refreshingSessions };
        delete next[sessionId];
        return { refreshingSessions: next };
      });
    }
  },

  sendMessageToSession: async (sessionId: string, content: string) => {
    const trimmed = content.trim();
    if (!sessionId || !trimmed) return;

    if (get().isSending) {
      set((state) => {
        const existing = state.queuedMessages[sessionId] || [];
        return {
          queuedMessages: {
            ...state.queuedMessages,
            [sessionId]: [...existing, trimmed],
          },
        };
      });
      return;
    }

    set({ isSending: true });
    set((state) => ({
      liveStatusBySession: {
        ...state.liveStatusBySession,
        [sessionId]: 'Thinking',
      },
      activeTurnStartedAt: {
        ...state.activeTurnStartedAt,
        [sessionId]: Date.now(),
      },
    }));
    try {
      await api.sendMessage(sessionId, trimmed);
    } catch (e) {
      console.error('Failed to send message:', e);
      set({ isSending: false });
      set((state) => {
        const nextStatus = { ...state.liveStatusBySession };
        const nextStart = { ...state.activeTurnStartedAt };
        delete nextStatus[sessionId];
        delete nextStart[sessionId];
        return {
          liveStatusBySession: nextStatus,
          activeTurnStartedAt: nextStart,
        };
      });
    }
  },

  flushQueuedMessages: async (sessionId: string) => {
    if (!sessionId || get().isSending) return;

    const queue = get().queuedMessages[sessionId] || [];
    if (queue.length === 0) return;

    const [next, ...rest] = queue;
    set((state) => {
      const updated = { ...state.queuedMessages };
      if (rest.length > 0) {
        updated[sessionId] = rest;
      } else {
        delete updated[sessionId];
      }
      return { queuedMessages: updated };
    });

    await get().sendMessageToSession(sessionId, next);
  },

  sendMessage: async (content: string) => {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    await get().sendMessageToSession(activeSessionId, content);
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

      const mapName = (s: Session) => s.id === session_id ? { ...s, name: newName } : s;
      set((state) => {
        const sessionsByProject = { ...state.sessionsByProject };
        for (const pid of Object.keys(sessionsByProject)) {
          sessionsByProject[pid] = sessionsByProject[pid].map(mapName);
        }
        return {
          sessions: state.sessions.map(mapName),
          sessionsByProject,
        };
      });
      return;
    }

    if (event_type === 'codex_message') {
      const method = asString((data as JsonRecord).method);
      if (method === 'turn/completed') {
        set({ isSending: false });
        set((state) => {
          const nextStatus = { ...state.liveStatusBySession };
          const nextStart = { ...state.activeTurnStartedAt };
          delete nextStatus[session_id];
          delete nextStart[session_id];
          return {
            liveStatusBySession: nextStatus,
            activeTurnStartedAt: nextStart,
          };
        });
        void get().flushQueuedMessages(session_id);
      }

      const status = parseCodexLiveStatus(data);
      if (typeof status === 'string' && status.trim()) {
        set((state) => ({
          liveStatusBySession: {
            ...state.liveStatusBySession,
            [session_id]: status,
          },
        }));
      } else if (status === null) {
        set((state) => {
          const nextStatus = { ...state.liveStatusBySession };
          delete nextStatus[session_id];
          return { liveStatusBySession: nextStatus };
        });
      }

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
      set((state) => ({
        liveStatusBySession: {
          ...state.liveStatusBySession,
          [session_id]: 'Thinking',
        },
      }));

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
      set({ isSending: false });
      set((state) => {
        const nextStatus = { ...state.liveStatusBySession };
        const nextStart = { ...state.activeTurnStartedAt };
        delete nextStatus[session_id];
        delete nextStart[session_id];
        return {
          liveStatusBySession: nextStatus,
          activeTurnStartedAt: nextStart,
        };
      });
      void get().flushQueuedMessages(session_id);

      // Save provider_session_id from Claude result for --resume and session sync
      const providerSid = asString(data.session_id);
      if (providerSid) {
        const session = get().sessions.find((s) => s.id === session_id);
        if (session && !session.provider_session_id) {
          set((state) => ({
            sessions: state.sessions.map((s) =>
              s.id === session_id ? { ...s, provider_session_id: providerSid } : s
            ),
          }));
          void api.saveProviderSessionId(session_id, providerSid);
        }
      }

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
      set({ isSending: false });
      set((state) => {
        const nextStatus = { ...state.liveStatusBySession };
        const nextStart = { ...state.activeTurnStartedAt };
        delete nextStatus[session_id];
        delete nextStart[session_id];
        return {
          liveStatusBySession: nextStatus,
          activeTurnStartedAt: nextStart,
        };
      });
      void get().flushQueuedMessages(session_id);

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

  toggleProjectExpanded: (projectId: string) => {
    set((state) => {
      const expandedProjects = {
        ...state.expandedProjects,
        [projectId]: !state.expandedProjects[projectId],
      };
      savePersisted('expandedProjects', expandedProjects);
      return { expandedProjects };
    });
  },

  setSidebarWidth: (width: number) => {
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
    // Keep main content usable when sidebar is expanded.
    const maxByViewport = Math.max(200, viewportWidth - 620);
    const clamped = Math.max(200, Math.min(width, 500, maxByViewport));
    savePersisted('sidebarWidth', clamped);
    set({ sidebarWidth: clamped });
  },

  // ─── UI Actions ───
  setShowSettings: (show: boolean) => set({ showSettings: show }),
  setShowNewProjectDialog: (show: boolean) => set({ showNewProjectDialog: show }),
  setShowNewSessionDialog: (show: boolean) => set({ showNewSessionDialog: show }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
}));
