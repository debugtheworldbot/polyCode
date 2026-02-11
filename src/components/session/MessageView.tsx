import { useEffect, useMemo, useRef, useState } from 'react';
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

function hasImagePlaceholder(content: string): boolean {
  return content.split('\n').some((line) => /^\[Image:\s*(.+?)\]\s*$/.test(line));
}

function isCollapsibleToolMessage(content: string): boolean {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return false;
  return normalized.includes('\n');
}

function splitToolMessage(content: string): { title: string; details: string | null } {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return { title: content.trim() || 'Tool', details: null };

  const lines = normalized.split('\n');
  const firstLine = lines[0]?.trim() || 'Tool';
  const details = lines.slice(1).join('\n').trim();
  return {
    title: firstLine.replace(/^•\s*/, ''),
    details: details || null,
  };
}

function ToolEditDetails({ details }: { details: string }) {
  return (
    <div className="tool-edit-details-block">
      {details.split('\n').map((line, index) => {
        const trimmed = line.trimStart();
        const lineClass = trimmed.startsWith('+')
          ? 'added'
          : trimmed.startsWith('-')
            ? 'removed'
            : trimmed.startsWith('@@') || trimmed.startsWith('•')
              ? 'meta'
              : 'context';
        return (
          <div key={`tool-edit-line-${index}`} className={`tool-edit-line ${lineClass}`}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}

function ToolMessageContent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = isCollapsibleToolMessage(content);
  const { title, details } = splitToolMessage(content);

  if (!collapsible) {
    return (
      <div className="tool-message-row">
        <span className="tool-icon">⏺</span>
        <span className="tool-title">{content}</span>
      </div>
    );
  }

  return (
    <div className="tool-edit-message">
      <button
        type="button"
        className="tool-edit-toggle"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <span className="tool-icon">⏺</span>
        <span className={`tool-edit-caret ${expanded ? 'expanded' : ''}`}>▸</span>
        <span className="tool-edit-title">{title}</span>
      </button>
      {expanded && details && <ToolEditDetails details={details} />}
    </div>
  );
}

function LocalImage({ path, alt }: { path: string; alt?: string }) {
  const [resolvedSrc, setResolvedSrc] = useState(() => convertFileSrc(path));
  const [fallbackTried, setFallbackTried] = useState(false);

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

function MessageContent({ content, imagesFirst = false }: { content: string; imagesFirst?: boolean }) {
  const segments = splitMessageContent(content);
  const orderedSegments = imagesFirst
    ? [
        ...segments.filter((segment) => segment.type === 'image'),
        ...segments.filter((segment) => segment.type === 'text'),
      ]
    : segments;
  return (
    <>
      {orderedSegments.map((segment, index) => {
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

function MessageBubble({ message }: { message: ChatMessage }) {
  const roleClass = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system';
  const isTool = message.message_type === 'tool';
  const hasImage = hasImagePlaceholder(message.content);

  if (isTool) {
    return (
      <div className="message-bubble tool animate-fadeIn" style={{ animationDelay: '0.1s' }}>
        <ToolMessageContent content={message.content} />
      </div>
    );
  }

  return (
    <div
      className={`message-bubble ${roleClass} ${roleClass === 'user' && hasImage ? 'with-image' : ''} animate-fadeIn`}
      style={{ animationDelay: '0.1s' }}
    >
      <div className="markdown-body" style={{ wordBreak: 'break-word' }}>
        <MessageContent content={message.content} imagesFirst={roleClass === 'user'} />
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
    sendingBySession,
  } = useAppStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId),
    [sessions, activeSessionId]
  );
  const currentMessages = useMemo(
    () => (activeSessionId ? messages[activeSessionId] || [] : []),
    [activeSessionId, messages]
  );
  const queuedCount = activeSessionId ? (queuedMessages[activeSessionId]?.length || 0) : 0;
  const liveStatus = activeSessionId ? liveStatusBySession[activeSessionId] : '';
  const turnStartedAt = activeSessionId ? activeTurnStartedAt[activeSessionId] : undefined;
  const isSending = activeSessionId ? Boolean(sendingBySession[activeSessionId]) : false;

  useEffect(() => {
    shouldAutoScrollRef.current = true;
  }, [activeSessionId]);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentMessages, isSending]);

  useEffect(() => {
    if (!isSending || !turnStartedAt) return;

    const updateElapsed = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - turnStartedAt) / 1000)));
    };

    const initialTimer = window.setTimeout(updateElapsed, 0);
    const timer = window.setInterval(updateElapsed, 1000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [isSending, turnStartedAt]);

  const safeElapsedSeconds = turnStartedAt ? elapsedSeconds : 0;
  const minutes = Math.floor(safeElapsedSeconds / 60);
  const seconds = safeElapsedSeconds % 60;
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
    <div
      className="messages-area"
      onScroll={(e) => {
        const el = e.currentTarget;
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
        shouldAutoScrollRef.current = nearBottom;
      }}
    >
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
        <MessageBubble key={msg.id} message={msg} />
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
