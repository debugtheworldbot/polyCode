import { useState, useRef, useEffect } from 'react';
import { Square, Plus, Mic, ChevronDown } from 'lucide-react';
import { useAppStore } from '../../store';
import { t } from '../../i18n';
import { MODEL_OPTIONS_BY_PROVIDER, getSessionModelLabel } from '../../constants/models';

export function Composer() {
  const {
    activeSessionId,
    sessions,
    queuedMessages,
    isSending,
    sendMessage,
    stopSession,
    setSessionModel,
  } = useAppStore();
  const [input, setInput] = useState('');
  const [showModelMenu, setShowModelMenu] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
    }
  }, [input]);

  useEffect(() => {
    if (activeSessionId && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [activeSessionId]);

  useEffect(() => {
    setShowModelMenu(false);
  }, [activeSessionId]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!modelMenuRef.current) return;
      if (modelMenuRef.current.contains(event.target as Node)) return;
      setShowModelMenu(false);
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSend = async () => {
    if (!input.trim() || !activeSessionId) return;
    const msg = input;
    setInput('');
    await sendMessage(msg);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStop = async () => {
    if (activeSessionId) {
      await stopSession(activeSessionId);
    }
  };

  if (!activeSessionId) return null;

  if (!activeSession) return null;

  const modelOptions = MODEL_OPTIONS_BY_PROVIDER[activeSession.provider];
  const selectedModel = activeSession.model?.trim() || '';
  const selectedOption = modelOptions.find((option) => option.value === selectedModel);
  const modelLabel = selectedOption?.label || getSessionModelLabel(activeSession.provider, selectedModel);
  const queuedCount = queuedMessages[activeSessionId]?.length || 0;
  const statusLabel = isSending
    ? queuedCount > 0
      ? `${t('session.running')} · ${queuedCount} queued`
      : t('session.running')
    : t('session.idle');
  const statusClassName = isSending ? 'running' : 'idle';

  return (
    <div className="composer-container">
      <div className="composer-box">
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('composer.placeholder')}
          rows={1}
        />
        
        <div className="composer-footer">
          <div className="composer-actions-left">
            <button className="icon-btn" title="Add Attachment">
              <Plus size={18} />
            </button>
            <div className="model-selector-wrap" ref={modelMenuRef}>
              <button
                className="icon-btn model-btn"
                style={{ gap: '6px', paddingRight: '8px', fontSize: '12px' }}
                onClick={() => setShowModelMenu((prev) => !prev)}
              >
                <span>{modelLabel}</span>
                <span className={`model-status ${statusClassName}`}>
                  <span className="model-status-dot" />
                  <span>{statusLabel}</span>
                </span>
                <ChevronDown size={12} />
              </button>
              {showModelMenu && (
                <div className="model-menu">
                  {modelOptions.map((option) => {
                    const isSelected = option.value === selectedModel;
                    return (
                      <button
                        key={option.value || '__default'}
                        className={`model-menu-item ${isSelected ? 'selected' : ''}`}
                        onClick={async () => {
                          try {
                            await setSessionModel(activeSessionId, option.value || null);
                          } catch (e) {
                            console.error('Failed to switch model:', e);
                          }
                          setShowModelMenu(false);
                        }}
                      >
                        <span>{option.label}</span>
                        {isSelected && <span>✓</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <button className="icon-btn" style={{ gap: '4px', paddingRight: '8px', fontSize: '12px' }}>
               <span>High</span>
               <ChevronDown size={12} />
            </button>
          </div>
          
          <div className="composer-actions-right">
             <button className="icon-btn">
               <Mic size={18} />
             </button>
            {isSending && (
              <button
                className="icon-btn"
                onClick={handleStop}
                title={t('session.stop')}
              >
                <Square size={14} />
              </button>
            )}
            <button
              className="send-btn"
              onClick={handleSend}
              disabled={!input.trim()}
              title={isSending ? 'Queue message' : t('composer.send')}
            >
              <div style={{ transform: 'rotate(-90deg) translateX(1px)' }}>
                 <div style={{ borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderBottom: '8px solid currentColor', width: 0, height: 0, margin: '0 auto' }}></div>
                 <div style={{ width: '2px', height: '8px', background: 'currentColor', margin: '-1px auto 0' }}></div>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
