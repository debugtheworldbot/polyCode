import { useState, useRef, useEffect } from 'react';
import { ChevronRight, ChevronDown, Folder, Plus, Pencil, Trash2, Square, RefreshCw } from 'lucide-react';
import { useAppStore } from '../../store';
import { t } from '../../i18n';
import { getSessionModelLabel } from '../../constants/models';

export function ProjectTree() {
  const {
    projects,
    sessionsByProject,
    expandedProjects,
    activeProjectId,
    activeSessionId,
    refreshingSessions,
    setActiveProject,
    setActiveSession,
    toggleProjectExpanded,
    removeProject,
    renameProject,
    removeSession,
    renameSession,
    stopSession,
    refreshSession,
    setShowNewSessionDialog,
    setShowNewProjectDialog,
  } = useAppStore();

  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const PAGE_SIZE = 10;

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    type: 'project' | 'session';
    id: string;
  } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingId]);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);

  const handleProjectClick = (projectId: string) => {
    if (activeProjectId === projectId) {
      toggleProjectExpanded(projectId);
    } else {
      void setActiveProject(projectId);
    }
  };

  const handleProjectContext = (e: React.MouseEvent, projectId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, type: 'project', id: projectId });
  };

  const handleSessionContext = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, type: 'session', id: sessionId });
  };

  const handleRename = () => {
    if (!contextMenu) return;
    if (contextMenu.type === 'project') {
      const p = projects.find((p) => p.id === contextMenu.id);
      if (p) { setEditingId(p.id); setEditName(p.name); }
    } else {
      for (const sessions of Object.values(sessionsByProject)) {
        const s = sessions.find((s) => s.id === contextMenu.id);
        if (s) { setEditingId(s.id); setEditName(s.name); break; }
      }
    }
    setContextMenu(null);
  };

  const handleRenameSubmit = async (id: string, type: 'project' | 'session') => {
    if (editName.trim()) {
      if (type === 'project') await renameProject(id, editName.trim());
      else await renameSession(id, editName.trim());
    }
    setEditingId(null);
  };

  const handleDelete = async () => {
    if (!contextMenu) return;
    setContextMenu(null);
    if (confirm(t('dialog.deleteConfirm'))) {
      if (contextMenu.type === 'project') await removeProject(contextMenu.id);
      else await removeSession(contextMenu.id);
    }
  };

  const handleStop = async () => {
    if (!contextMenu || contextMenu.type !== 'session') return;
    setContextMenu(null);
    await stopSession(contextMenu.id);
  };

  if (projects.length === 0) {
    return (
      <div style={{ padding: '20px 12px', fontSize: '12px', color: 'var(--color-text-muted)', textAlign: 'center', background: 'rgba(0,0,0,0.02)', borderRadius: '12px', border: '1px dashed var(--color-border)' }}>
        {t('sidebar.noProjects')}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
      {projects.map((project) => {
        const isExpanded = !!expandedProjects[project.id];
        const isActive = activeProjectId === project.id;
        const allSessions = (sessionsByProject[project.id] || [])
          .slice()
          .sort((a, b) => b.updated_at - a.updated_at);
        const visibleCount = visibleCounts[project.id] || PAGE_SIZE;
        const sessions = allSessions.slice(0, visibleCount);
        const hasMore = allSessions.length > visibleCount;
        const remaining = allSessions.length - visibleCount;

        return (
          <div key={project.id}>
            {/* Project row */}
            <div
              className={`sidebar-item ${isActive ? 'active' : ''}`}
              onClick={() => handleProjectClick(project.id)}
              onContextMenu={(e) => handleProjectContext(e, project.id)}
            >
              {isExpanded
                ? <ChevronDown size={14} style={{ flexShrink: 0, color: 'var(--color-text-secondary)' }} />
                : <ChevronRight size={14} style={{ flexShrink: 0, color: 'var(--color-text-secondary)' }} />
              }
              <Folder size={15} style={{ flexShrink: 0, color: isActive ? 'var(--color-text)' : 'var(--color-text-secondary)' }} />
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {editingId === project.id ? (
                  <input
                    ref={editRef}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => handleRenameSubmit(project.id, 'project')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRenameSubmit(project.id, 'project');
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    style={{ width: '100%', border: 'none', background: 'white', padding: '0 2px', borderRadius: '2px', color: '#000' }}
                  />
                ) : (
                  project.name
                )}
              </div>
            </div>

            {/* Sessions under project */}
            {isExpanded && (
              <div style={{ paddingLeft: '20px' }}>
                {sessions.map((session) => (
                  <div
                    key={session.id}
                    className={`sidebar-item ${activeSessionId === session.id ? 'active' : ''}`}
                    onClick={() => {
                      if (activeProjectId !== project.id) void setActiveProject(project.id);
                      void setActiveSession(session.id);
                    }}
                    onContextMenu={(e) => handleSessionContext(e, session.id)}
                  >
                    <div style={{
                      width: '16px',
                      height: '16px',
                      borderRadius: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '11px',
                      fontWeight: 700,
                      background: session.provider === 'codex' ? 'rgba(16, 185, 129, 0.15)' : session.provider === 'gemini' ? 'rgba(37, 99, 235, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                      color: session.provider === 'codex' ? '#10b981' : session.provider === 'gemini' ? '#2563eb' : '#f59e0b',
                      flexShrink: 0,
                    }}>
                      {session.provider === 'codex' ? '\u2B21' : session.provider === 'gemini' ? '\u2605' : '\u25C8'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {editingId === session.id ? (
                        <input
                          ref={editRef}
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onBlur={() => handleRenameSubmit(session.id, 'session')}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRenameSubmit(session.id, 'session');
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          style={{ width: '100%', border: 'none', background: 'white', padding: '0 2px', borderRadius: '2px' }}
                        />
                      ) : (
                        <span title={getSessionModelLabel(session.provider, session.model)}>
                          {session.name}
                        </span>
                      )}
                    </div>
                    <button
                      className="session-refresh-btn"
                      title="Refresh session"
                      disabled={!!refreshingSessions[session.id]}
                      onClick={(e) => {
                        e.stopPropagation();
                        void refreshSession(session.id);
                      }}
                    >
                      <RefreshCw
                        size={12}
                        className={refreshingSessions[session.id] ? 'session-refresh-icon spinning' : 'session-refresh-icon'}
                      />
                    </button>
                  </div>
                ))}
                {hasMore && (
                  <button
                    className="sidebar-item show-more-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setVisibleCounts((prev) => ({
                        ...prev,
                        [project.id]: (prev[project.id] || PAGE_SIZE) + PAGE_SIZE,
                      }));
                    }}
                  >
                    <span>Show More ({remaining})</span>
                  </button>
                )}
                <button
                  className="sidebar-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (activeProjectId !== project.id) void setActiveProject(project.id);
                    setShowNewSessionDialog(true);
                  }}
                  style={{ color: 'var(--color-text-muted)', fontSize: '12px' }}
                >
                  <Plus size={12} />
                  <span>New Thread</span>
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={handleRename}>
            <Pencil size={14} />
            {t('session.rename')}
          </div>
          {contextMenu.type === 'session' && (
            <div className="context-menu-item" onClick={handleStop}>
              <Square size={14} />
              {t('session.stop')}
            </div>
          )}
          <div className="context-menu-item danger" onClick={handleDelete}>
            <Trash2 size={14} />
            {t('session.delete')}
          </div>
        </div>
      )}
    </div>
  );
}
