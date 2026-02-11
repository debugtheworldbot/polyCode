import { useState, useEffect } from 'react';
import { X, Check, AlertCircle } from 'lucide-react';
import { useAppStore } from '../../store';
import { checkCliAvailable } from '../../services/tauri';
import { t } from '../../i18n';
import type { AppSettings, CLIStatus } from '../../types';

const DEFAULT_WINDOW_TRANSPARENCY = 80;

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

  useEffect(() => {
    if (!showSettings) {
      applyWindowTransparency(settings.window_transparency);
    }
  }, [showSettings, settings.window_transparency]);

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
      applyWindowTransparency(localSettings.window_transparency);
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
  };

  if (!showSettings) return null;

  return (
    <div className="settings-panel">
      <div className="settings-backdrop" onClick={() => setShowSettings(false)} />
      <div className="settings-content animate-fadeIn">
        <div className="settings-header">
          <div>
            <h2 className="settings-title">{t('settings.title')}</h2>
            <p className="settings-subtitle">Configure your workspace</p>
          </div>
          <button className="btn-icon" onClick={() => setShowSettings(false)}>
            <X size={18} />
          </button>
        </div>

        <div className="settings-scroll">
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

            <div className="settings-row settings-row-stack">
              <div className="settings-row-head">
                <label>{t('settings.transparency')}</label>
                <span className="settings-range-value">
                  {Math.max(0, Math.min(100, Math.round(localSettings.window_transparency ?? DEFAULT_WINDOW_TRANSPARENCY)))}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.max(0, Math.min(100, Math.round(localSettings.window_transparency ?? DEFAULT_WINDOW_TRANSPARENCY)))}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  setLocalSettings({ ...localSettings, window_transparency: value });
                  applyWindowTransparency(value);
                }}
                style={{ width: '100%' }}
              />
              <div className="settings-range-hints">
                <span>{t('settings.transparencyWeak')}</span>
                <span>{t('settings.transparencyStrong')}</span>
              </div>
            </div>
          </div>

          {/* CLI Configuration */}
          <div className="settings-section">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <h3>{t('settings.cli')}</h3>
              <button className="btn btn-ghost" onClick={checkCLIs} style={{ fontSize: '11px', padding: '4px 8px', borderRadius: '8px', border: '1px solid var(--color-border)', flexShrink: 0 }}>
                <AlertCircle size={12} />
                {t('settings.cliStatus')}
              </button>
            </div>

            <div className="form-group" style={{ marginBottom: '24px' }}>
              <label className="form-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{t('settings.codexPath')}</span>
                {codexStatus && (
                  <span style={{
                    fontSize: '11px',
                    color: codexStatus.available ? 'var(--color-success)' : 'var(--color-error)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontWeight: 600,
                    background: codexStatus.available ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                    padding: '2px 8px',
                    borderRadius: '6px',
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
                style={{ marginTop: '4px' }}
              />
            </div>

            <div className="form-group">
              <label className="form-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{t('settings.claudePath')}</span>
                {claudeStatus && (
                  <span style={{
                    fontSize: '11px',
                    color: claudeStatus.available ? 'var(--color-success)' : 'var(--color-error)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontWeight: 600,
                    background: claudeStatus.available ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                    padding: '2px 8px',
                    borderRadius: '6px',
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
                style={{ marginTop: '4px' }}
              />
            </div>
          </div>
        </div>

        {/* Save Button */}
        <div className="settings-footer">
          <button className="btn btn-primary settings-save-btn" onClick={handleSave}>
            {saved ? (
              <>
                <Check size={16} />
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

function clampTransparency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WINDOW_TRANSPARENCY;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function applyWindowTransparency(transparency: number) {
  const level = clampTransparency(transparency);
  const ratio = level / 100;
  const root = document.documentElement;

  const lightBgAlpha = 0.78 - ratio * 0.28;
  const lightSidebarAlpha = 0.62 - ratio * 0.28;
  const darkBgAlpha = 0.74 - ratio * 0.28;
  const darkSidebarAlpha = 0.58 - ratio * 0.24;

  root.style.setProperty('--glass-alpha-bg-light', lightBgAlpha.toFixed(2));
  root.style.setProperty('--glass-alpha-sidebar-light', lightSidebarAlpha.toFixed(2));
  root.style.setProperty('--glass-alpha-bg-dark', darkBgAlpha.toFixed(2));
  root.style.setProperty('--glass-alpha-sidebar-dark', darkSidebarAlpha.toFixed(2));
}

// Export for use in App initialization
export { applyTheme, applyWindowTransparency };
