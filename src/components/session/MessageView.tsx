import { useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppStore } from '../../store';
import * as api from '../../services/tauri';
import { t } from '../../i18n';
import type { ChatMessage } from '../../types';

type ContentSegment =
  | { type: 'text'; value: string }
  | { type: 'image'; value: string };

function getFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return segments[segments.length - 1] || 'image';
}

function splitMessageContent(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  const textBuffer: string[] = [];

  const flushText = () => {
    const text = textBuffer.join('\n').trim();
    textBuffer.length = 0;
    if (text) segments.push({ type: 'text', value: text });
  };

  for (const line of content.split('\n')) {
    const match = line.match(/^\[Image:\s*(.+?)\]\s*$/);
    if (match) {
      flushText();
      const path = match[1].trim();
      if (path) segments.push({ type: 'image', value: path });
      continue;
    }
    textBuffer.push(line);
  }

  flushText();
  if (segments.length === 0 && content.trim()) {
    return [{ type: 'text', value: content.trim() }];
  }
  return segments;
}

function LocalImage({ path, alt }: { path: string; alt?: string }) {
  const [resolvedSrc, setResolvedSrc] = useState(convertFileSrc(path));
  const [fallbackTried, setFallbackTried] = useState(false);

  useEffect(() => {
    setFallbackTried(false);
    setResolvedSrc(convertFileSrc(path));
  }, [path]);

  const handleError = async () => {
    if (fallbackTried) return;
    setFallbackTried(true);
    try {
      const dataUrl = await api.readImageDataUrl(path);
      setResolvedSrc(dataUrl);
    } catch (e) {
      console.error('Failed to load local image fallback:', e);
    }
  };

  return <img src={resolvedSrc} alt={alt || getFileName(path)} onError={handleError} />;
}

function MessageContent({ content }: { content: string }) {
  const segments = splitMessageContent(content);
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === 'image') {
          return <LocalImage key={`img-${index}-${segment.value}`} path={segment.value} />;
        }

        return (
          <ReactMarkdown key={`txt-${index}`} remarkPlugins={[remarkGfm]}>
            {segment.value}
          </ReactMarkdown>
        );
      })}
    </>
  );
}

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
        <MessageContent content={message.content} />
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
            <MessageContent content={content} />
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
