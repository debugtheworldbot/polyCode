import { create } from 'zustand';
import type { Project, Session, ChatMessage, AppSettings, SessionEvent, AIProvider } from '../types';
import * as api from '../services/tauri';
import { setLanguage } from '../i18n';

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

    // Handle streaming text from both Codex and Claude
    if (
      event_type === 'codex_message' ||
      event_type === 'claude_stream' ||
      event_type === 'claude_message'
    ) {
      // Extract text content
      let text = '';
      if (event_type === 'codex_message') {
        // Codex app-server messages
        const method = data.method as string | undefined;
        if (method === 'thread/message') {
          const params = data.params as Record<string, unknown> | undefined;
          if (params) {
            text = (params.text as string) || (params.content as string) || JSON.stringify(params);
          }
        } else if (data.result !== undefined) {
          // Response to a request
          return;
        } else {
          text = JSON.stringify(data);
        }
      } else if (event_type === 'claude_stream') {
        // Claude stream events
        const evt = data.event as Record<string, unknown> | undefined;
        if (evt) {
          const delta = evt.delta as Record<string, unknown> | undefined;
          if (delta && delta.type === 'text_delta') {
            text = (delta.text as string) || '';
          }
        }
        if (!text) return;
      } else {
        text = JSON.stringify(data);
      }

      if (!text) return;

      set((state) => {
        const existing = state.messages[session_id] || [];
        // Check if we should append to the last assistant message or create new
        const lastMsg = existing[existing.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && lastMsg.message_type === 'text') {
          // Append to existing message (streaming)
          const updated = [...existing];
          updated[updated.length - 1] = {
            ...lastMsg,
            content: lastMsg.content + text,
          };
          return { messages: { ...state.messages, [session_id]: updated } };
        } else {
          // Create new assistant message
          const newMsg: ChatMessage = {
            id: crypto.randomUUID(),
            session_id,
            role: 'assistant',
            content: text,
            message_type: 'text',
            created_at: Date.now(),
          };
          return {
            messages: { ...state.messages, [session_id]: [...existing, newMsg] },
          };
        }
      });
      return;
    }

    // Handle Claude result (final message)
    if (event_type === 'claude_result') {
      const result = (data.result as string) || '';
      if (result) {
        set((state) => {
          const existing = state.messages[session_id] || [];
          const lastMsg = existing[existing.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            // The streaming already built the message, just finalize
            return state;
          }
          const newMsg: ChatMessage = {
            id: crypto.randomUUID(),
            session_id,
            role: 'assistant',
            content: result,
            message_type: 'text',
            created_at: Date.now(),
          };
          return {
            messages: { ...state.messages, [session_id]: [...existing, newMsg] },
          };
        });
      }
      return;
    }

    // Handle errors
    if (event_type === 'codex_error' || event_type === 'claude_error') {
      const errorMsg = (data.message as string) || 'Unknown error';
      set((state) => {
        const existing = state.messages[session_id] || [];
        const newMsg: ChatMessage = {
          id: crypto.randomUUID(),
          session_id,
          role: 'system',
          content: errorMsg,
          message_type: 'error',
          created_at: Date.now(),
        };
        return {
          messages: { ...state.messages, [session_id]: [...existing, newMsg] },
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
