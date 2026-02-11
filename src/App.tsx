import { useEffect } from 'react';
import { useAppStore } from './store';
import { onSessionEvent } from './services/tauri';
import { Sidebar } from './components/sidebar/Sidebar';
import { SessionHeader } from './components/session/SessionHeader';
import { MessageView } from './components/session/MessageView';
import { Composer } from './components/composer/Composer';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { applyTheme, applyWindowTransparency } from './components/settings/SettingsPanel';
import { NewProjectDialog } from './components/common/NewProjectDialog';
import { NewSessionDialog } from './components/common/NewSessionDialog';
import { GitPanel } from './components/git/GitPanel';

export default function App() {
  const { initialize, handleSessionEvent, settings } = useAppStore();

  useEffect(() => {
    initialize();
  }, [initialize]);

  // Apply theme on settings change
  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    applyWindowTransparency(settings.window_transparency);
  }, [settings.window_transparency]);

  // Listen for session events from Tauri backend
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    onSessionEvent((event) => {
      handleSessionEvent(event);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, [handleSessionEvent]);

  // Listen for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (settings.theme === 'system') {
        applyTheme('system');
      }
    };
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [settings.theme]);

  return (
    <div className="app-layout">
      <Sidebar />
      <div className="main-content">
        <SessionHeader />
        <MessageView />
        <Composer />
      </div>
      <GitPanel />
      <SettingsPanel />
      <NewProjectDialog />
      <NewSessionDialog />
    </div>
  );
}
