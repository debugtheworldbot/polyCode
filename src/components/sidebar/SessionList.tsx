import { useState, useRef, useEffect } from 'react';
import { MessageCircle, Plus, MoreHorizontal, Pencil, Trash2, Square } from 'lucide-react';
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
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 8px' }}>
        <span className="sidebar-section-title" style={{ padding: 0 }}>
          <MessageCircle size={12} style={{ display: 'inline', marginRight: '4px', verticalAlign: 'middle' }} />
          {t('sidebar.sessions')}
        </span>
        <button
          className="btn-icon"
          onClick={() => setShowNewSessionDialog(true)}
          title={t('sidebar.newSession')}
          style={{ padding: '4px' }}
        >
          <Plus size={14} />
        </button>
      </div>

      {sortedSessions.length === 0 ? (
        <div style={{ padding: '12px 8px', fontSize: '12px', color: 'var(--color-text-muted)' }}>
          {t('sidebar.noSessions')}
        </div>
      ) : (
        <div style={{ marginTop: '4px' }}>
          {sortedSessions.map((session) => (
            <div
              key={session.id}
              className={`session-item ${activeSessionId === session.id ? 'active' : ''}`}
              onClick={() => setActiveSession(session.id)}
              onContextMenu={(e) => handleContextMenu(e, session.id)}
            >
              <span className={`provider-badge ${session.provider}`}>
                {session.provider === 'codex' ? '⬡' : '◈'}
                {session.provider === 'codex' ? t('session.codex') : t('session.claude')}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                {editingId === session.id ? (
                  <input
                    ref={editRef}
                    className="form-input"
                    style={{ padding: '2px 6px', fontSize: '13px' }}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => handleRenameSubmit(session.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRenameSubmit(session.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px' }}>
                    {session.name}
                  </div>
                )}
              </div>
              <button
                className="btn-icon"
                onClick={(e) => { e.stopPropagation(); handleContextMenu(e, session.id); }}
                style={{ padding: '2px', opacity: 0.5 }}
              >
                <MoreHorizontal size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

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
    </>
  );
}
