import { useEffect, useRef } from 'react';
import { Bot, User, AlertCircle } from 'lucide-react';
import { useAppStore } from '../../store';
import { t } from '../../i18n';
import type { ChatMessage } from '../../types';

function MessageBubble({ message, provider }: { message: ChatMessage; provider?: string }) {
  const roleClass = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system';
  const isTool = message.message_type === 'tool';
  
  if (isTool) {
    return (
      <div className="message-bubble tool animate-fadeIn" style={{ animationDelay: '0.1s' }}>
        <span style={{ opacity: 0.7 }}>{message.content}</span>
      </div>
    );
  }

  return (
    <div className={`message-bubble ${roleClass} animate-fadeIn`} style={{
      animationDelay: '0.1s',
    }}>
      {/* Remove Headers for minimalist look */}
      <div style={{ 
        whiteSpace: 'pre-wrap', 
        wordBreak: 'break-word',
      }}>
        {formatContent(message.content)}
      </div>
    </div>
  );
}

function formatContent(content: string) {
  // Simple code block detection
  const parts = content.split(/(```[\s\S]*?```)/g);
  return parts.map((part, i) => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const inner = part.slice(3, -3);
      const firstNewline = inner.indexOf('\n');
      const lang = firstNewline > 0 ? inner.slice(0, firstNewline).trim() : '';
      const code = firstNewline > 0 ? inner.slice(firstNewline + 1) : inner;
      return (
        <div key={i} style={{ 
          position: 'relative', 
          margin: '12px 0',
          borderRadius: '12px',
          overflow: 'hidden',
          border: '1px solid var(--color-border)',
        }}>
          {lang && (
            <div style={{
              background: 'var(--color-bg-secondary)',
              padding: '4px 12px',
              fontSize: '11px',
              fontWeight: 600,
              color: 'var(--color-text-muted)',
              borderBottom: '1px solid var(--color-border)',
              textTransform: 'uppercase',
            }}>
              {lang}
            </div>
          )}
          <pre style={{ 
            margin: 0, 
            padding: '16px',
            borderRadius: 0,
            border: 'none',
            background: 'var(--color-bg-tertiary)',
          }}>
            <code style={{ color: 'var(--color-text)' }}>{code}</code>
          </pre>
        </div>
      );
    }
    // Inline code
    const inlineParts = part.split(/(`[^`]+`)/g);
    return inlineParts.map((ip, j) => {
      if (ip.startsWith('`') && ip.endsWith('`')) {
        return <code key={`${i}-${j}`} style={{
          background: 'rgba(0, 0, 0, 0.06)', // Light gray background
          color: 'var(--color-text)',
          padding: '2px 6px',
          borderRadius: '6px',
          fontSize: '13px',
          fontWeight: 500,
          fontFamily: "'JetBrains Mono', monospace"
        }}>{ip.slice(1, -1)}</code>;
      }
      return <span key={`${i}-${j}`}>{ip}</span>;
    });
  });
}

export function MessageView() {
  const { activeSessionId, sessions, messages, isSending } = useAppStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const currentMessages = activeSessionId ? messages[activeSessionId] || [] : [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentMessages]);

  if (!activeSessionId || !activeSession) {
    return (
      <div className="empty-state">
        <Bot size={48} />
        <p>{t('messages.noSession')}</p>
      </div>
    );
  }

  return (
    <div className="messages-area">
      {currentMessages.length === 0 && (
        <div className="empty-state" style={{ flex: 1 }}>
          <div style={{
            width: '64px',
            height: '64px',
            borderRadius: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '28px',
            fontWeight: 700,
            background: activeSession.provider === 'codex' ? 'var(--color-codex-bg)' : 'var(--color-claude-bg)',
            color: activeSession.provider === 'codex' ? 'var(--color-codex)' : 'var(--color-claude)',
          }}>
            {activeSession.provider === 'codex' ? '⬡' : '◈'}
          </div>
          <p style={{ fontWeight: 500, color: 'var(--color-text)', fontSize: '15px' }}>
            {activeSession.provider === 'codex' ? t('messages.welcomeCodex') : t('messages.welcomeClaude')}
          </p>
          <p>{t('messages.welcome')}</p>
        </div>
      )}

      {currentMessages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} provider={activeSession.provider} />
      ))}

      {isSending && (
        <div className="message-bubble assistant animate-fadeIn" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div className="animate-pulse" style={{ display: 'flex', gap: '4px' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--color-text-muted)' }} />
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--color-text-muted)', animationDelay: '0.2s' }} />
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--color-text-muted)', animationDelay: '0.4s' }} />
          </div>
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
}
