import { useAppStore } from '../../store';
import { t } from '../../i18n';

export function SessionHeader() {
  const { activeSessionId, sessions, activeProjectId, projects } = useAppStore();

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const activeProject = projects.find(p => p.id === activeProjectId);

  if (!activeSession) {
    return (
      <div className="main-header">
        <h2>CodexHub</h2>
      </div>
    );
  }

  return (
    <div className="main-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span className={`provider-badge ${activeSession.provider}`} style={{ fontSize: '11px', padding: '3px 8px' }}>
          {activeSession.provider === 'codex' ? '⬡' : '◈'}
          {activeSession.provider === 'codex' ? t('session.codex') : t('session.claude')}
        </span>
        <h2 style={{ margin: 0 }}>{activeSession.name}</h2>
      </div>
      {activeProject && (
        <div style={{
          fontSize: '12px',
          color: 'var(--color-text-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}>
          <span style={{
            background: 'var(--color-bg-tertiary)',
            padding: '2px 8px',
            borderRadius: '4px',
            fontFamily: 'monospace',
            fontSize: '11px',
          }}>
            {activeProject.path}
          </span>
        </div>
      )}
    </div>
  );
}
