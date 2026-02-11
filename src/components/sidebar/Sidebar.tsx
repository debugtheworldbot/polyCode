import { useRef, useCallback, useEffect } from 'react';
import { Settings, Plus } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../../store';
import { ProjectTree } from './ProjectTree';

function handleDrag(e: React.MouseEvent) {
  if (e.button !== 0) return;
  const tag = (e.target as HTMLElement).closest('button, a, input, [role="button"]');
  if (tag) return;
  getCurrentWindow().startDragging();
}

export function Sidebar() {
  const {
    sidebarCollapsed,
    sidebarWidth,
    setSidebarWidth,
    setShowSettings,
    setShowNewProjectDialog,
  } = useAppStore();

  const resizing = useRef(false);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const newWidth = startWidth + (ev.clientX - startX);
      setSidebarWidth(newWidth);
    };

    const onUp = () => {
      resizing.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [sidebarWidth, setSidebarWidth]);

  useEffect(() => {
    // Clamp persisted width on mount and keep it valid on window resize.
    const enforceSidebarBounds = () => {
      const maxByViewport = Math.max(200, window.innerWidth - 620);
      const clamped = Math.max(200, Math.min(sidebarWidth, 500, maxByViewport));
      if (clamped !== sidebarWidth) {
        setSidebarWidth(clamped);
      }
    };
    enforceSidebarBounds();
    window.addEventListener('resize', enforceSidebarBounds);
    return () => window.removeEventListener('resize', enforceSidebarBounds);
  }, [sidebarWidth, setSidebarWidth]);

  if (sidebarCollapsed) return null;

  return (
    <div className="sidebar" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
      {/* Drag region for macOS traffic lights area */}
      <div className="sidebar-drag-region" onMouseDown={handleDrag} />
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

      {/* Tree Section */}
      <div className="sidebar-section sidebar-scroll">
        <ProjectTree />
      </div>

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

      {/* Resize handle */}
      <div className="sidebar-resize-handle" onMouseDown={onResizeStart} />
    </div>
  );
}
