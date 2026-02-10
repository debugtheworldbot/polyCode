import { useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppStore } from '../../store';
import { t } from '../../i18n';
import type { ChatMessage } from '../../types';

function getFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return segments[segments.length - 1] || 'image';
}

function renderLocalImagePlaceholders(content: string): string {
  return content.replace(/^\[Image:\s*(.+?)\]\s*$/gm, (_match, rawPath: string) => {
    const path = rawPath.trim();
    if (!path) return '';
    const src = convertFileSrc(path);
    const fileName = getFileName(path);
    return `![${fileName}](${src})`;
  });
}

function MessageBubble({ message, provider }: { message: ChatMessage; provider?: string }) {
  const roleClass = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system';
  const isTool = message.message_type === 'tool';
  const renderedContent = renderLocalImagePlaceholders(message.content);

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
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{renderedContent}</ReactMarkdown>
      </div>
    </div>
  );
}

export function MessageView() {
  const {
    activeSessionId,
    sessions,
    messages,
    queuedMessages,
    liveStatusBySession,
    activeTurnStartedAt,
    isSending,
  } = useAppStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const currentMessages = activeSessionId ? messages[activeSessionId] || [] : [];
  const queuedItems = activeSessionId ? (queuedMessages[activeSessionId] || []) : [];
  const queuedCount = activeSessionId ? (queuedMessages[activeSessionId]?.length || 0) : 0;
  const liveStatus = activeSessionId ? liveStatusBySession[activeSessionId] : '';
  const turnStartedAt = activeSessionId ? activeTurnStartedAt[activeSessionId] : undefined;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentMessages, queuedItems, isSending]);

  useEffect(() => {
    if (!isSending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isSending]);

  const elapsedSeconds = turnStartedAt
    ? Math.max(0, Math.floor((now - turnStartedAt) / 1000))
    : 0;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsedLabel = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

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
      {currentMessages.length === 0 && queuedCount === 0 && (
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
            background: activeSession.provider === 'codex' ? 'var(--color-codex-bg)' : activeSession.provider === 'gemini' ? 'var(--color-gemini-bg)' : 'var(--color-claude-bg)',
            color: activeSession.provider === 'codex' ? 'var(--color-codex)' : activeSession.provider === 'gemini' ? 'var(--color-gemini)' : 'var(--color-claude)',
          }}>
            {activeSession.provider === 'codex' ? '⬡' : activeSession.provider === 'gemini' ? '★' : '◈'}
          </div>
          <p style={{ fontWeight: 500, color: 'var(--color-text)', fontSize: '15px' }}>
            {activeSession.provider === 'codex' ? t('messages.welcomeCodex') : activeSession.provider === 'gemini' ? 'Gemini Session' : t('messages.welcomeClaude')}
          </p>
          <p>{t('messages.welcome')}</p>
        </div>
      )}

      {currentMessages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} provider={activeSession.provider} />
      ))}

      {queuedItems.map((content, index) => (
        <div
          key={`queued-${index}-${content}`}
          className="message-bubble user queued animate-fadeIn"
          style={{ animationDelay: `${0.06 * (index + 1)}s` }}
        >
          <div className="markdown-body" style={{ wordBreak: 'break-word' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {renderLocalImagePlaceholders(content)}
            </ReactMarkdown>
          </div>
          <span className="queued-tag">queued</span>
        </div>
      ))}

      {isSending && (
        <div className="message-bubble assistant animate-fadeIn" style={{ opacity: 0.72, fontStyle: 'italic' }}>
          {(liveStatus || 'Thinking')}{` (${elapsedLabel} • esc to interrupt${queuedCount > 0 ? ` • ${queuedCount} queued` : ''})`}
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
}
