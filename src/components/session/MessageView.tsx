import { useEffect, useRef } from 'react';
import { Bot } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
    <div className={`message-bubble ${roleClass} animate-fadeIn`} style={{ animationDelay: '0.1s' }}>
      <div className="markdown-body" style={{ wordBreak: 'break-word' }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
      </div>
    </div>
  );
}

export function MessageView() {
  const { activeSessionId, sessions, messages, isSending } = useAppStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const currentMessages = activeSessionId ? messages[activeSessionId] || [] : [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentMessages, isSending]);

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
        <div className="message-bubble assistant animate-fadeIn" style={{ opacity: 0.72, fontStyle: 'italic' }}>
          thinking...
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
}
