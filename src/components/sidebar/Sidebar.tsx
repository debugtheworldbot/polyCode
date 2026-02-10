import { FolderOpen, Plus, Settings, PanelLeftClose, PanelLeftOpen, MessageSquare } from 'lucide-react';
import { useAppStore } from '../../store';
import { t } from '../../i18n';
import { ProjectList } from './ProjectList';
import { SessionList } from './SessionList';

export function Sidebar() {
  const {
    activeProjectId,
    sidebarCollapsed,
    toggleSidebar,
    setShowSettings,
    setShowNewProjectDialog,
  } = useAppStore();

  if (sidebarCollapsed) {
    return (
      <div className="sidebar collapsed">
        <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
          <button className="btn-icon" onClick={toggleSidebar} title="Expand sidebar">
            <PanelLeftOpen size={18} />
          </button>
          <button className="btn-icon" onClick={() => setShowNewProjectDialog(true)} title={t('sidebar.addProject')}>
            <Plus size={18} />
          </button>
          <button className="btn-icon" onClick={() => setShowSettings(true)} title={t('sidebar.settings')}>
            <Settings size={18} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <MessageSquare size={20} style={{ color: 'var(--color-primary)' }} />
          <span style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '-0.01em' }}>
            CodexHub
          </span>
        </div>
        <button className="btn-icon" onClick={toggleSidebar} title="Collapse sidebar">
          <PanelLeftClose size={16} />
        </button>
      </div>

      {/* Projects Section */}
      <div className="sidebar-section" style={{ flex: 'none', maxHeight: '40%', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 8px' }}>
          <span className="sidebar-section-title" style={{ padding: 0 }}>
            <FolderOpen size={12} style={{ display: 'inline', marginRight: '4px', verticalAlign: 'middle' }} />
            {t('sidebar.projects')}
          </span>
          <button
            className="btn-icon"
            onClick={() => setShowNewProjectDialog(true)}
            title={t('sidebar.addProject')}
            style={{ padding: '4px' }}
          >
            <Plus size={14} />
          </button>
        </div>
        <ProjectList />
      </div>

      {/* Sessions Section */}
      {activeProjectId && (
        <div className="sidebar-section" style={{ flex: 1, borderTop: '1px solid var(--color-border)' }}>
          <SessionList />
        </div>
      )}

      {/* Footer */}
      <div className="sidebar-footer">
        <button
          className="btn btn-ghost"
          onClick={() => setShowSettings(true)}
          style={{ width: '100%', justifyContent: 'flex-start' }}
        >
          <Settings size={14} />
          {t('sidebar.settings')}
        </button>
      </div>
    </div>
  );
}
