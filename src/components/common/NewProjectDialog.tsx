import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useAppStore } from '../../store';
import { pickDirectory } from '../../services/tauri';
import { t } from '../../i18n';

export function NewProjectDialog() {
  const { showNewProjectDialog, setShowNewProjectDialog, addProject } = useAppStore();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState('');

  if (!showNewProjectDialog) return null;

  const handlePickFolder = async () => {
    try {
      const selected = await pickDirectory();
      if (selected) {
        setPath(selected);
        if (!name) {
          // Auto-fill name from folder name
          const parts = selected.split(/[/\\]/);
          setName(parts[parts.length - 1] || '');
        }
      }
    } catch (e) {
      console.error('Failed to pick directory:', e);
    }
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError('Project name is required');
      return;
    }
    if (!path.trim()) {
      setError('Project path is required');
      return;
    }
    try {
      await addProject(name.trim(), path.trim());
      setName('');
      setPath('');
      setError('');
      setShowNewProjectDialog(false);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleClose = () => {
    setName('');
    setPath('');
    setError('');
    setShowNewProjectDialog(false);
  };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content animate-fadeIn" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{t('sidebar.addProject')}</h3>

        <div className="form-group">
          <label className="form-label">{t('dialog.projectName')}</label>
          <input
            className="form-input"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(''); }}
            placeholder="My Project"
            autoFocus
          />
        </div>

        <div className="form-group">
          <label className="form-label">{t('dialog.selectFolder')}</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              className="form-input"
              value={path}
              onChange={(e) => { setPath(e.target.value); setError(''); }}
              placeholder="/path/to/project"
              style={{ flex: 1 }}
            />
            <button className="btn btn-ghost" onClick={handlePickFolder} style={{ border: '1px solid var(--color-border)', flexShrink: 0 }}>
              <FolderOpen size={14} />
            </button>
          </div>
        </div>

        {error && (
          <div style={{ color: 'var(--color-error)', fontSize: '12px', marginBottom: '8px' }}>
            {error}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={handleClose}>
            {t('dialog.cancel')}
          </button>
          <button className="btn btn-primary" onClick={handleSubmit}>
            {t('dialog.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
