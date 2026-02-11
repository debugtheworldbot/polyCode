import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Folder, Pencil, Trash2 } from 'lucide-react';
import { useAppStore } from '../../store';
import { t } from '../../i18n';

export function ProjectList() {
  const { projects, activeProjectId, setActiveProject, removeProject, renameProject } = useAppStore();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; projectId: string } | null>(null);
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

  if (projects.length === 0) {
    return (
      <div style={{ padding: '20px 12px', fontSize: '12px', color: 'var(--color-text-muted)', textAlign: 'center', background: 'rgba(0,0,0,0.02)', borderRadius: '12px', border: '1px dashed var(--color-border)' }}>
        {t('sidebar.noProjects')}
      </div>
    );
  }

  const handleContextMenu = (e: React.MouseEvent, projectId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, projectId });
  };

  const handleRename = (projectId: string) => {
    const project = projects.find(p => p.id === projectId);
    if (project) {
      setEditingId(projectId);
      setEditName(project.name);
    }
    setContextMenu(null);
  };

  const handleRenameSubmit = async (projectId: string) => {
    if (editName.trim()) {
      await renameProject(projectId, editName.trim());
    }
    setEditingId(null);
  };

  const handleDelete = async (projectId: string) => {
    setContextMenu(null);
    if (confirm(t('dialog.deleteConfirm'))) {
      await removeProject(projectId);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
      {projects.map((project) => (
        <div
          key={project.id}
          className={`sidebar-item ${activeProjectId === project.id ? 'active' : ''}`}
          onClick={() => setActiveProject(project.id)}
          onContextMenu={(e) => handleContextMenu(e, project.id)}
        >
          <Folder size={15} style={{ color: activeProjectId === project.id ? 'var(--color-text)' : 'var(--color-text-secondary)' }} />
          <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {editingId === project.id ? (
              <input
                ref={editRef}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => handleRenameSubmit(project.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameSubmit(project.id);
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
      ))}
      
      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={() => handleRename(contextMenu.projectId)}>
            <Pencil size={14} />
            {t('session.rename')}
          </div>
          <div className="context-menu-item danger" onClick={() => handleDelete(contextMenu.projectId)}>
            <Trash2 size={14} />
            {t('session.delete')}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}