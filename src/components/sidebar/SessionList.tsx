import { useState, useRef, useEffect } from 'react';
import { MessageCircle, Plus, MoreHorizontal, Pencil, Trash2, Square, RefreshCw } from 'lucide-react';
import { useAppStore } from '../../store';
import { t } from '../../i18n';

export function SessionList() {
  const {
    sessions,
    activeSessionId,
    setActiveSession,
    removeSession,
    renameSession,
    stopSession,
    refreshSession,
    refreshingSessions,
    setShowNewSessionDialog,
  } = useAppStore();

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
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

  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
  };

  const handleRename = (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      setEditingId(sessionId);
      setEditName(session.name);
    }
    setContextMenu(null);
  };

  const handleRenameSubmit = async (sessionId: string) => {
    if (editName.trim()) {
      await renameSession(sessionId, editName.trim());
    }
    setEditingId(null);
  };

  const handleDelete = async (sessionId: string) => {
    setContextMenu(null);
    if (confirm(t('dialog.deleteConfirm'))) {
      await removeSession(sessionId);
    }
  };

  const handleStop = async (sessionId: string) => {
    setContextMenu(null);
    await stopSession(sessionId);
  };

  const sortedSessions = [...sessions].sort((a, b) => b.updated_at - a.updated_at);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
      <button 
        className="sidebar-item" 
        onClick={() => setShowNewSessionDialog(true)}
        style={{ color: 'var(--color-text-secondary)', marginBottom: '4px' }}
      >
        <Plus size={14} />
        <span>New Thread</span>
      </button>

      {sortedSessions.map((session) => (
        <div
          key={session.id}
          className={`sidebar-item ${activeSessionId === session.id ? 'active' : ''}`}
          onClick={() => setActiveSession(session.id)}
          onContextMenu={(e) => handleContextMenu(e, session.id)}
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
            background: session.provider === 'codex' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
            color: session.provider === 'codex' ? '#10b981' : '#f59e0b',
            flexShrink: 0
          }}>
            {session.provider === 'codex' ? '⬡' : '◈'}
          </div>
          <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {editingId === session.id ? (
              <input
                ref={editRef}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => handleRenameSubmit(session.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameSubmit(session.id);
                  if (e.key === 'Escape') setEditingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
                style={{ width: '100%', border: 'none', background: 'white', padding: '0 2px', borderRadius: '2px' }}
              />
            ) : (
              session.name
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

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={() => handleRename(contextMenu.sessionId)}>
            <Pencil size={14} />
            {t('session.rename')}
          </div>
          <div className="context-menu-item" onClick={() => handleStop(contextMenu.sessionId)}>
            <Square size={14} />
            {t('session.stop')}
          </div>
          <div className="context-menu-item danger" onClick={() => handleDelete(contextMenu.sessionId)}>
            <Trash2 size={14} />
            {t('session.delete')}
          </div>
        </div>
      )}
    </div>
  );
}
