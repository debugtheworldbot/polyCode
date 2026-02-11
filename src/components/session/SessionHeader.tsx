import { GitCommit, ChevronRight, Sidebar } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../../store';
import { getSessionModelLabel } from '../../constants/models';

function handleDrag(e: React.MouseEvent) {
  if (e.button !== 0) return;
  // Don't drag when clicking interactive elements
  const target = e.target;
  const tag =
    target instanceof Element
      ? target.closest('button, a, input, [role="button"]')
      : null;
  if (tag) return;
  getCurrentWindow().startDragging();
}

export function SessionHeader() {
  const {
    activeSessionId,
    sessions,
    activeProjectId,
    projects,
    sidebarCollapsed,
    showGitPanel,
    toggleSidebar,
    toggleGitPanel,
  } = useAppStore();

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const activeProject = projects.find(p => p.id === activeProjectId);
  const modelLabel = activeSession
    ? getSessionModelLabel(activeSession.provider, activeSession.model)
    : null;

  const handleGitButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    toggleGitPanel();
  };

  // When sidebar is collapsed, leave space for macOS traffic lights
  const trafficLightPad = sidebarCollapsed ? 78 : 0;

  if (!activeSession) {
    return (
      <div className="main-header" onMouseDown={handleDrag}>
        <div className="main-header-left" style={{ paddingLeft: trafficLightPad }}>
          <button className="header-btn" onClick={toggleSidebar} style={{ border: 'none', padding: '4px' }}>
            <Sidebar size={16} />
          </button>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="header-btn"
            style={showGitPanel ? { background: 'var(--color-sidebar-active)' } : undefined}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleGitButtonClick}
          >
            <GitCommit size={14} />
            <span>Git</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="main-header" onMouseDown={handleDrag}>
      <div className="main-header-left" style={{ paddingLeft: trafficLightPad }}>
        <button className="header-btn" onClick={toggleSidebar} style={{ border: 'none', padding: '4px', marginRight: '4px' }}>
          <Sidebar size={16} />
        </button>

        <div className="breadcrumb">
           {activeProject && (
             <>
               <span className="breadcrumb-project">{activeProject.name}</span>
               <ChevronRight size={14} style={{ opacity: 0.4 }} />
             </>
           )}
           <span className="breadcrumb-session">{activeSession.name}</span>
           <span className="session-model-chip">{modelLabel}</span>
        </div>
      </div>

      <div className="header-actions">
        <button
          type="button"
          className="header-btn"
          style={showGitPanel ? { background: 'var(--color-sidebar-active)' } : undefined}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleGitButtonClick}
        >
          <GitCommit size={14} />
          <span>Git</span>
        </button>
      </div>
    </div>
  );
}
