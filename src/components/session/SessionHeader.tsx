import { FolderOpen, GitCommit, ChevronRight, Sidebar, MoreHorizontal } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../../store';
import { t } from '../../i18n';
import { getSessionModelLabel } from '../../constants/models';

function handleDrag(e: React.MouseEvent) {
  if (e.button !== 0) return;
  // Don't drag when clicking interactive elements
  const tag = (e.target as HTMLElement).closest('button, a, input, [role="button"]');
  if (tag) return;
  getCurrentWindow().startDragging();
}

export function SessionHeader() {
  const { activeSessionId, sessions, activeProjectId, projects, sidebarCollapsed, toggleSidebar } = useAppStore();

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const activeProject = projects.find(p => p.id === activeProjectId);

  // When sidebar is collapsed, leave space for macOS traffic lights
  const trafficLightPad = sidebarCollapsed ? 78 : 0;

  if (!activeSession) {
    return (
      <div className="main-header" onMouseDown={handleDrag}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingLeft: trafficLightPad }}>
          <button className="header-btn" onClick={toggleSidebar} style={{ border: 'none', padding: '4px' }}>
            <Sidebar size={16} />
          </button>
        </div>
      </div>
    );
  }

  const modelLabel = getSessionModelLabel(activeSession.provider, activeSession.model);

  return (
    <div className="main-header" onMouseDown={handleDrag}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', paddingLeft: trafficLightPad }}>
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
           <span className="session-model-chip">{modelLabel}</span>
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
