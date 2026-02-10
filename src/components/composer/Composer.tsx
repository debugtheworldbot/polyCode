import { useState, useRef, useEffect } from 'react';
import { Send, Square, Plus, Mic, ChevronDown } from 'lucide-react';
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
    <div className="composer-container">
      <div className="composer-box">
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask for follow-up changes"
          rows={1}
          disabled={isSending}
        />
        
        <div className="composer-footer">
          <div className="composer-actions-left">
            <button className="icon-btn" title="Add Attachment">
              <Plus size={18} />
            </button>
            <button className="icon-btn" style={{ gap: '4px', paddingRight: '8px', fontSize: '12px' }}>
              <span>GPT-5.3-Codex</span>
              <ChevronDown size={12} />
            </button>
            <button className="icon-btn" style={{ gap: '4px', paddingRight: '8px', fontSize: '12px' }}>
               <span>High</span>
               <ChevronDown size={12} />
            </button>
          </div>
          
          <div className="composer-actions-right">
             <button className="icon-btn">
               <Mic size={18} />
             </button>
            {isSending ? (
              <button
                className="send-btn"
                onClick={handleStop}
                title={t('session.stop')}
              >
                <Square size={10} fill="currentColor" />
              </button>
            ) : (
              <button
                className="send-btn"
                onClick={handleSend}
                disabled={!input.trim()}
                title={t('composer.send')}
              >
                <div style={{ transform: 'rotate(-90deg) translateX(1px)' }}>
                   <div style={{ borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderBottom: '8px solid currentColor', width: 0, height: 0, margin: '0 auto' }}></div>
                   <div style={{ width: '2px', height: '8px', background: 'currentColor', margin: '-1px auto 0' }}></div>
                </div>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
