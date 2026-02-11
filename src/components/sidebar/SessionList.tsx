import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { MessageCircle, Plus, MoreHorizontal, Pencil, Trash2, RefreshCw } from 'lucide-react';
import { useAppStore } from '../../store';
import { t } from '../../i18n';
import { getSessionModelLabel } from '../../constants/models';

export function SessionList() {
  const {
    sessions,
    activeSessionId,
    setActiveSession,
    removeSession,
    renameSession,
    refreshSession,
    refreshingSessions,
    setShowNewSessionDialog,
  } = useAppStore();

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const editRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useCallback((el: HTMLDivElement | null) => {
    if (!el || !contextMenu) return;
    const rect = el.getBoundingClientRect();
    let x = contextMenu.x;
    let y = contextMenu.y;
    if (rect.bottom > window.innerHeight) y = window.innerHeight - rect.height - 8;
    if (rect.right > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y < 0) y = 8;
    if (x < 0) x = 8;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [contextMenu]);

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
            background: session.provider === 'codex' ? 'rgba(16, 185, 129, 0.15)' : session.provider === 'gemini' ? 'rgba(37, 99, 235, 0.15)' : 'rgba(245, 158, 11, 0.15)',
            color: session.provider === 'codex' ? '#10b981' : session.provider === 'gemini' ? '#2563eb' : '#f59e0b',
            flexShrink: 0
          }}>
            {session.provider === 'codex' ? '⬡' : session.provider === 'gemini' ? '★' : '◈'}
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

      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={() => handleRename(contextMenu.sessionId)}>
            <Pencil size={14} />
            {t('session.rename')}
          </div>
<div className="context-menu-item danger" onClick={() => handleDelete(contextMenu.sessionId)}>
            <Trash2 size={14} />
            {t('session.delete')}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
