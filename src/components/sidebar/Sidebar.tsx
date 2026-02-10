import { Folder, MessageSquare, Settings, Plus, LayoutGrid, Clock } from 'lucide-react';
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

  if (sidebarCollapsed) return null; // Or render a tiny strip if preferred

  return (
    <div className="sidebar">
      {/* Sidebar Header */}
      <div style={{ padding: '0 12px 16px' }}>
        <button 
          className="sidebar-item" 
          onClick={() => setShowNewProjectDialog(true)}
          style={{ width: '100%', justifyContent: 'flex-start', fontWeight: 600 }}
        >
          <Plus size={14} />
          <span>New Project</span>
        </button>
      </div>

      {/* Projects Section */}
      <div className="sidebar-section">
        <div className="sidebar-section-title">Projects</div>
        <ProjectList />
      </div>

      {/* Threads Section */}
      {activeProjectId && (
        <div className="sidebar-section" style={{ flex: 1, overflowY: 'auto', marginTop: '8px' }}>
           <div className="sidebar-section-title">Threads</div>
          <SessionList />
        </div>
      )}

      {/* Footer / Settings */}
      <div className="sidebar-footer">
        <button
          className="sidebar-item"
          onClick={() => setShowSettings(true)}
          style={{ width: '100%' }}
        >
          <Settings size={15} />
          <span>Settings</span>
        </button>
      </div>
    </div>
  );
}