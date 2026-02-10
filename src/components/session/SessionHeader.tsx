import { FolderOpen, GitCommit, ChevronRight, Sidebar, MoreHorizontal } from 'lucide-react';
import { useAppStore } from '../../store';
import { t } from '../../i18n';

export function SessionHeader() {
  const { activeSessionId, sessions, activeProjectId, projects, toggleSidebar } = useAppStore();

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const activeProject = projects.find(p => p.id === activeProjectId);

  if (!activeSession) {
    return (
      <div className="main-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button className="header-btn" onClick={toggleSidebar} style={{ border: 'none', padding: '4px' }}>
            <Sidebar size={16} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="main-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button className="header-btn" onClick={toggleSidebar} style={{ border: 'none', padding: '4px', marginRight: '4px' }}>
          <Sidebar size={16} />
        </button>

        <div className="breadcrumb">
           {activeProject && (
             <>
               <span style={{ opacity: 0.7 }}>{activeProject.name}</span>
               <ChevronRight size={14} style={{ opacity: 0.4 }} />
             </>
           )}
           <span>{activeSession.name}</span>
        </div>
      </div>
      
      <div className="header-actions">
        <button className="header-btn">
          <FolderOpen size={14} />
          <span>Open</span>
        </button>
        <button className="header-btn">
          <GitCommit size={14} />
          <span>Commit</span>
        </button>
        <div style={{ width: '1px', height: '20px', background: 'var(--color-divider)', margin: '0 4px' }} />
        <button className="header-btn" style={{ padding: '4px 6px' }}>
          <MoreHorizontal size={14} />
        </button>
      </div>
    </div>
  );
}
