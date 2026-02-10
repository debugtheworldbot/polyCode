import { useState, useEffect } from 'react';
import { X, Check, AlertCircle } from 'lucide-react';
import { useAppStore } from '../../store';
import { checkCliAvailable } from '../../services/tauri';
import { t } from '../../i18n';
import type { AppSettings, CLIStatus } from '../../types';

export function SettingsPanel() {
  const { showSettings, setShowSettings, settings, updateSettings } = useAppStore();
  const [localSettings, setLocalSettings] = useState<AppSettings>(settings);
  const [codexStatus, setCodexStatus] = useState<CLIStatus | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<CLIStatus | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (showSettings) {
      checkCLIs();
    }
  }, [showSettings]);

  const checkCLIs = async () => {
    try {
      const codex = await checkCliAvailable(localSettings.codex_bin || 'codex');
      setCodexStatus(codex);
    } catch {
      setCodexStatus({ available: false, path: null });
    }
    try {
      const claude = await checkCliAvailable(localSettings.claude_bin || 'claude');
      setClaudeStatus(claude);
    } catch {
      setClaudeStatus({ available: false, path: null });
    }
  };

  const handleSave = async () => {
    try {
      await updateSettings(localSettings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      // Apply theme
      applyTheme(localSettings.theme);
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
  };

  if (!showSettings) return null;

  return (
    <div className="settings-panel">
      <div className="settings-backdrop" onClick={() => setShowSettings(false)} />
      <div className="settings-content animate-fadeIn">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 700 }}>{t('settings.title')}</h2>
          <button className="btn-icon" onClick={() => setShowSettings(false)}>
            <X size={18} />
          </button>
        </div>

        {/* General Section */}
        <div className="settings-section">
          <h3>{t('settings.general')}</h3>

          <div className="settings-row">
            <label>{t('settings.theme')}</label>
            <select
              className="settings-select"
              value={localSettings.theme}
              onChange={(e) => setLocalSettings({ ...localSettings, theme: e.target.value })}
            >
              <option value="light">{t('settings.themeLight')}</option>
              <option value="dark">{t('settings.themeDark')}</option>
              <option value="system">{t('settings.themeSystem')}</option>
            </select>
          </div>

          <div className="settings-row">
            <label>{t('settings.language')}</label>
            <select
              className="settings-select"
              value={localSettings.language}
              onChange={(e) => setLocalSettings({ ...localSettings, language: e.target.value })}
            >
              <option value="system">{t('settings.langSystem')}</option>
              <option value="en">{t('settings.langEn')}</option>
              <option value="zh">{t('settings.langZh')}</option>
            </select>
          </div>
        </div>

        {/* CLI Configuration */}
        <div className="settings-section">
          <h3>{t('settings.cli')}</h3>

          <div className="form-group">
            <label className="form-label">
              {t('settings.codexPath')}
              {codexStatus && (
                <span style={{
                  marginLeft: '8px',
                  fontSize: '11px',
                  color: codexStatus.available ? 'var(--color-success)' : 'var(--color-error)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}>
                  <span className={`status-dot ${codexStatus.available ? 'available' : 'unavailable'}`} />
                  {codexStatus.available ? t('settings.available') : t('settings.notFound')}
                </span>
              )}
            </label>
            <input
              className="form-input"
              value={localSettings.codex_bin || ''}
              onChange={(e) => setLocalSettings({ ...localSettings, codex_bin: e.target.value || null })}
              placeholder={t('settings.pathPlaceholder')}
            />
          </div>

          <div className="form-group">
            <label className="form-label">
              {t('settings.claudePath')}
              {claudeStatus && (
                <span style={{
                  marginLeft: '8px',
                  fontSize: '11px',
                  color: claudeStatus.available ? 'var(--color-success)' : 'var(--color-error)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}>
                  <span className={`status-dot ${claudeStatus.available ? 'available' : 'unavailable'}`} />
                  {claudeStatus.available ? t('settings.available') : t('settings.notFound')}
                </span>
              )}
            </label>
            <input
              className="form-input"
              value={localSettings.claude_bin || ''}
              onChange={(e) => setLocalSettings({ ...localSettings, claude_bin: e.target.value || null })}
              placeholder={t('settings.pathPlaceholder')}
            />
          </div>

          <button className="btn btn-ghost" onClick={checkCLIs} style={{ fontSize: '12px', border: '1px solid var(--color-border)' }}>
            <AlertCircle size={13} />
            {t('settings.cliStatus')}
          </button>
        </div>

        {/* Save Button */}
        <div style={{ marginTop: '20px' }}>
          <button className="btn btn-primary" onClick={handleSave} style={{ width: '100%' }}>
            {saved ? (
              <>
                <Check size={14} />
                {t('settings.saved')}
              </>
            ) : (
              t('settings.save')
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function applyTheme(theme: string) {
  const root = document.documentElement;
  if (theme === 'dark') {
    root.classList.add('dark');
  } else if (theme === 'light') {
    root.classList.remove('dark');
  } else {
    // System preference
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }
}

// Export for use in App initialization
export { applyTheme };
