import { useState, useRef, useEffect } from 'react';
import { Send, Square } from 'lucide-react';
import { useAppStore } from '../../store';
import { t } from '../../i18n';

export function Composer() {
  const { activeSessionId, isSending, sendMessage, stopSession } = useAppStore();
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const handleSend = async () => {
    if (!input.trim() || isSending || !activeSessionId) return;
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

  return (
    <div className="composer">
      <div className="composer-inner">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('composer.placeholder')}
          rows={1}
          disabled={isSending}
        />
        {isSending ? (
          <button
            className="btn-icon"
            onClick={handleStop}
            title={t('session.stop')}
            style={{ color: 'var(--color-error)', padding: '6px' }}
          >
            <Square size={18} fill="currentColor" />
          </button>
        ) : (
          <button
            className="btn-icon"
            onClick={handleSend}
            disabled={!input.trim()}
            title={t('composer.send')}
            style={{
              color: input.trim() ? 'var(--color-primary)' : 'var(--color-text-muted)',
              padding: '6px',
            }}
          >
            <Send size={18} />
          </button>
        )}
      </div>
      <div style={{
        fontSize: '11px',
        color: 'var(--color-text-muted)',
        textAlign: 'center',
        marginTop: '6px',
      }}>
        Press Enter to send, Shift+Enter for new line
      </div>
    </div>
  );
}
