import { useState, useRef, useEffect } from 'react';
import { Folder, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useAppStore } from '../../store';
import { t } from '../../i18n';

export function ProjectList() {
  const { projects, activeProjectId, setActiveProject, removeProject, renameProject } = useAppStore();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; projectId: string } | null>(null);
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

  if (projects.length === 0) {
    return (
      <div style={{ padding: '12px 8px', fontSize: '12px', color: 'var(--color-text-muted)' }}>
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
    <>
      <div style={{ marginTop: '4px' }}>
        {projects.map((project) => (
          <div
            key={project.id}
            className={`project-item ${activeProjectId === project.id ? 'active' : ''}`}
            onClick={() => setActiveProject(project.id)}
            onContextMenu={(e) => handleContextMenu(e, project.id)}
          >
            <Folder size={15} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              {editingId === project.id ? (
                <input
                  ref={editRef}
                  className="form-input"
                  style={{ padding: '2px 6px', fontSize: '13px' }}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={() => handleRenameSubmit(project.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRenameSubmit(project.id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {project.name}
                  </div>
                  <div className="project-path">{project.path.split('/').pop()}</div>
                </>
              )}
            </div>
            <button
              className="btn-icon"
              onClick={(e) => { e.stopPropagation(); handleContextMenu(e, project.id); }}
              style={{ padding: '2px', opacity: 0.5 }}
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
        ))}
      </div>

      {contextMenu && (
        <div
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
        </div>
      )}
    </>
  );
}
