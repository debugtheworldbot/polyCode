import { useState } from 'react';
import { useAppStore } from '../../store';
import { t } from '../../i18n';
import type { AIProvider } from '../../types';

type CreatableProvider = Exclude<AIProvider, 'gemini'>;

export function NewSessionDialog() {
  const { showNewSessionDialog, setShowNewSessionDialog, activeProjectId, createSession } = useAppStore();
  const [selectedProvider, setSelectedProvider] = useState<CreatableProvider>('codex');
  const [name, setName] = useState('');

  if (!showNewSessionDialog || !activeProjectId) return null;

  const handleSubmit = async () => {
    try {
      await createSession(activeProjectId, selectedProvider, name || undefined);
      setName('');
      setSelectedProvider('codex');
      setShowNewSessionDialog(false);
    } catch (e) {
      console.error('Failed to create session:', e);
    }
  };

  const handleClose = () => {
    setName('');
    setSelectedProvider('codex');
    setShowNewSessionDialog(false);
  };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content animate-fadeIn" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{t('dialog.chooseProvider')}</h3>

        <div style={{ marginBottom: '16px' }}>
          <div
            className={`provider-card ${selectedProvider === 'codex' ? 'selected' : ''}`}
            onClick={() => setSelectedProvider('codex')}
          >
            <div className="provider-icon codex">⬡</div>
            <div className="provider-info">
              <h4>{t('provider.codex')}</h4>
              <p>{t('provider.codexDesc')}</p>
            </div>
          </div>

          <div
            className={`provider-card ${selectedProvider === 'claude' ? 'selected' : ''}`}
            onClick={() => setSelectedProvider('claude')}
          >
            <div className="provider-icon claude">◈</div>
            <div className="provider-info">
              <h4>{t('provider.claude')}</h4>
              <p>{t('provider.claudeDesc')}</p>
            </div>
          </div>

        </div>

        <div className="form-group">
          <label className="form-label">Session Name (optional)</label>
          <input
            className="form-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`${selectedProvider === 'codex' ? 'Codex' : 'Claude'} Session`}
          />
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={handleClose}>
            {t('dialog.cancel')}
          </button>
          <button className="btn btn-primary" onClick={handleSubmit}>
            {t('dialog.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
