import { useEffect, useMemo, useRef, useState } from 'react';
import { Square, Plus, X } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useAppStore } from '../../store';
import * as api from '../../services/tauri';
import { t } from '../../i18n';
import type { SlashCommand } from '../../types';

const FALLBACK_CODEX_SLASH_COMMANDS: SlashCommand[] = [
  { command: '/apps', description: 'Browse or manage connected ChatGPT apps.' },
  { command: '/collab', description: 'Open collaboration mode controls.' },
  { command: '/compact', description: 'Compact the current conversation to save context.' },
  { command: '/environments', description: 'Inspect available execution environments.' },
  { command: '/experimental', description: 'Toggle experimental Codex features.' },
  { command: '/feedback', description: 'Send logs and feedback to Codex maintainers.' },
  { command: '/fork', description: 'Fork the current thread into a new one.' },
  { command: '/init', description: 'Create an AGENTS.md for project-specific guidance.' },
  { command: '/mcp', description: 'List configured MCP tools and servers.' },
  { command: '/model', description: 'Switch model or reasoning effort.' },
  { command: '/new', description: 'Start a fresh thread.' },
  { command: '/permissions', description: 'Adjust approval and permission behavior.' },
  { command: '/personality', description: 'Choose Codex communication style.' },
  { command: '/plan', description: 'Switch to plan mode.' },
  { command: '/ps', description: 'View active turns and related process state.' },
  { command: '/rename', description: 'Rename the current thread.' },
  { command: '/review', description: 'Run a code review on current changes.' },
  { command: '/skills', description: 'List and inspect available skills.' },
  { command: '/status', description: 'Show model, approvals, and usage status.' },
  { command: '/usage', description: 'Show usage and rate-limit details.' },
];

function getFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return segments[segments.length - 1] || path;
}

function getQueuedPreview(content: string): string {
  const textOnly = content
    .replace(/\[Image:\s*.+?\]\s*/g, '[Image] ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!textOnly) return '[Image]';
  return textOnly.length > 120 ? `${textOnly.slice(0, 120)}...` : textOnly;
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.max(0, Math.round(value)));
}

function findSlashContext(content: string, caret: number): { start: number; query: string } | null {
  if (caret < 1) return null;

  let start = caret - 1;
  while (start >= 0) {
    const ch = content[start];
    if (ch === ' ' || ch === '\n' || ch === '\t') break;
    start -= 1;
  }
  start += 1;

  const token = content.slice(start, caret);
  if (!/^\/[a-zA-Z0-9_-]*$/.test(token)) return null;

  return {
    start,
    query: token.slice(1).toLowerCase(),
  };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Invalid image payload'));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(file);
  });
}

export function Composer() {
  const {
    activeSessionId,
    sessions,
    queuedMessages,
    contextUsageBySession,
    liveStatusBySession,
    activeTurnStartedAt,
    isSending,
    sendMessage,
    stopSession,
  } = useAppStore();
  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(FALLBACK_CODEX_SLASH_COMMANDS);
  const [showSlashPopover, setShowSlashPopover] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const composerContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
    setImages([]);
  }, [activeSessionId]);

  useEffect(() => {
    let cancelled = false;
    if (activeSession?.provider !== 'codex') {
      setShowSlashPopover(false);
      setSlashCommands(FALLBACK_CODEX_SLASH_COMMANDS);
      return () => {
        cancelled = true;
      };
    }

    api
      .listCodexSlashCommands()
      .then((commands) => {
        if (cancelled) return;
        if (commands.length > 0) {
          setSlashCommands(commands);
        } else {
          setSlashCommands(FALLBACK_CODEX_SLASH_COMMANDS);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load Codex slash commands:', err);
        setSlashCommands(FALLBACK_CODEX_SLASH_COMMANDS);
      });

    return () => {
      cancelled = true;
    };
  }, [activeSession?.provider]);

  useEffect(() => {
    const container = composerContainerRef.current;
    if (!container) return;
    const mainContent = container.closest('.main-content');
    if (!(mainContent instanceof HTMLElement)) return;

    const updateSafePadding = () => {
      const { height } = container.getBoundingClientRect();
      const bottomOffset = Number.parseFloat(window.getComputedStyle(container).bottom) || 0;
      const safePadding = Math.ceil(height + bottomOffset + 16);
      mainContent.style.setProperty('--composer-safe-padding', `${safePadding}px`);
    };

    updateSafePadding();
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateSafePadding) : null;
    observer?.observe(container);
    window.addEventListener('resize', updateSafePadding);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateSafePadding);
      mainContent.style.removeProperty('--composer-safe-padding');
    };
  }, [activeSessionId]);

  const filteredSlashCommands = useMemo(() => {
    const query = slashQuery.trim();
    if (!query) return slashCommands;
    return slashCommands.filter((item) => item.command.slice(1).toLowerCase().startsWith(query));
  }, [slashCommands, slashQuery]);

  useEffect(() => {
    setActiveSlashIndex((prev) => {
      if (filteredSlashCommands.length === 0) return 0;
      return Math.min(prev, filteredSlashCommands.length - 1);
    });
  }, [filteredSlashCommands.length]);

  const syncSlashPopover = (nextInput: string, caret: number | null) => {
    if (activeSession?.provider !== 'codex' || caret === null) {
      setShowSlashPopover(false);
      return;
    }

    const context = findSlashContext(nextInput, caret);
    if (!context) {
      setShowSlashPopover(false);
      return;
    }

    setSlashQuery(context.query);
    setActiveSlashIndex(0);
    setShowSlashPopover(true);
  };

  const applySlashCommand = (command: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const caret = textarea.selectionStart ?? input.length;
    const context = findSlashContext(input, caret);
    if (!context) return;

    const insertion = command.startsWith('/') ? `${command} ` : `/${command} `;
    const nextInput = `${input.slice(0, context.start)}${insertion}${input.slice(caret)}`;
    const nextCaret = context.start + insertion.length;

    setInput(nextInput);
    setShowSlashPopover(false);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const handleSend = async () => {
    if ((!input.trim() && images.length === 0) || !activeSessionId) return;
    const text = input.trim();
    const imageMarkdown = images
      .map((path) => `[Image: ${path}]`)
      .join('\n');
    const msg = [text, imageMarkdown].filter(Boolean).join('\n\n');
    setInput('');
    setImages([]);
    setShowSlashPopover(false);
    await sendMessage(msg);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSlashPopover) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveSlashIndex((prev) =>
          filteredSlashCommands.length === 0 ? 0 : (prev + 1) % filteredSlashCommands.length
        );
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveSlashIndex((prev) =>
          filteredSlashCommands.length === 0
            ? 0
            : (prev - 1 + filteredSlashCommands.length) % filteredSlashCommands.length
        );
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && filteredSlashCommands.length > 0) {
        e.preventDefault();
        applySlashCommand(filteredSlashCommands[activeSlashIndex]?.command || filteredSlashCommands[0].command);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlashPopover(false);
        return;
      }
    }

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

  const handlePickImages = async () => {
    try {
      const selected = await api.pickImages();
      if (selected.length === 0) return;
      setImages((prev) => Array.from(new Set([...prev, ...selected])));
    } catch (e) {
      console.error('Failed to pick images:', e);
    }
  };

  const handleRemoveImage = (target: string) => {
    setImages((prev) => prev.filter((path) => path !== target));
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);

    if (imageFiles.length === 0) return;

    e.preventDefault();
    try {
      const savedPaths = await Promise.all(
        imageFiles.map(async (file) => {
          const dataUrl = await fileToDataUrl(file);
          return api.savePastedImage(dataUrl);
        })
      );
      setImages((prev) => Array.from(new Set([...prev, ...savedPaths])));
    } catch (err) {
      console.error('Failed to paste image:', err);
    }
  };

  if (!activeSessionId) return null;

  if (!activeSession) return null;

  const queuedItems = queuedMessages[activeSessionId] || [];
  const queuedCount = queuedMessages[activeSessionId]?.length || 0;
  const contextUsage = contextUsageBySession[activeSessionId] || null;
  const usedTokens = contextUsage?.usedTokens ?? 0;
  const maxTokens = contextUsage?.maxTokens ?? null;
  const lastTurnTokens = contextUsage?.lastTotalTokens ?? 0;
  const totalInputTokens = contextUsage?.totalInputTokens ?? 0;
  const totalOutputTokens = contextUsage?.totalOutputTokens ?? 0;
  const totalCachedInputTokens = contextUsage?.totalCachedInputTokens ?? 0;
  const totalReasoningOutputTokens = contextUsage?.totalReasoningOutputTokens ?? 0;
  const contextPercent = contextUsage?.usagePercent ?? null;
  const contextPercentClamped = contextPercent === null
    ? 0
    : Math.max(0, Math.min(100, contextPercent));
  const contextPercentText = contextPercent === null
    ? '--'
    : `${contextPercentClamped.toFixed(1)}%`;
  const statusLabel = isSending
    ? queuedCount > 0
      ? `${t('session.running')} · ${queuedCount} queued`
      : t('session.running')
    : t('session.idle');
  const statusClassName = isSending ? 'running' : 'idle';
  const isCurrentSessionRunning = Boolean(
    liveStatusBySession[activeSessionId] || activeTurnStartedAt[activeSessionId]
  );

  return (
    <div className="composer-container" ref={composerContainerRef}>
      {queuedItems.length > 0 && (
        <div className="composer-queue">
          {queuedItems.map((content, index) => (
            <div key={`composer-queue-${index}-${content}`} className="composer-queue-item">
              <span className="composer-queue-label">#{index + 1}</span>
              <span className="composer-queue-preview">{getQueuedPreview(content)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="composer-box">
        {showSlashPopover && (
          <div className="slash-popover" role="listbox" aria-label="Codex slash commands">
            {filteredSlashCommands.length > 0 ? (
              filteredSlashCommands.map((item, index) => (
                <button
                  key={item.command}
                  type="button"
                  className={`slash-popover-item ${index === activeSlashIndex ? 'active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applySlashCommand(item.command);
                  }}
                >
                  <span className="slash-popover-command">{item.command}</span>
                  {item.description.trim() && (
                    <span className="slash-popover-description">{item.description}</span>
                  )}
                </button>
              ))
            ) : (
              <div className="slash-popover-empty">No matching slash command</div>
            )}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={input}
          onChange={(e) => {
            const nextInput = e.target.value;
            setInput(nextInput);
            syncSlashPopover(nextInput, e.target.selectionStart);
          }}
          onKeyDown={handleKeyDown}
          onSelect={(e) => {
            const el = e.currentTarget;
            syncSlashPopover(el.value, el.selectionStart);
          }}
          onClick={(e) => {
            const el = e.currentTarget;
            syncSlashPopover(el.value, el.selectionStart);
          }}
          onPaste={handlePaste}
          placeholder={t('composer.placeholder')}
          rows={1}
        />

        {images.length > 0 && (
          <div className="composer-attachments">
            {images.map((path) => {
              const fileName = getFileName(path);
              return (
                <div key={path} className="composer-attachment-item">
                  <img
                    className="composer-attachment-thumb"
                    src={convertFileSrc(path)}
                    alt={fileName}
                    loading="lazy"
                  />
                  <div className="composer-attachment-name" title={fileName}>
                    {fileName}
                  </div>
                  <button
                    className="composer-attachment-remove"
                    title={t('composer.removeImage')}
                    onClick={() => handleRemoveImage(path)}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        
        <div className="composer-footer">
          <div className="composer-actions-left">
            <button className="icon-btn" title={t('composer.addImage')} onClick={handlePickImages}>
              <Plus size={18} />
            </button>
            <span className={`model-status ${statusClassName}`} style={{ fontSize: '12px', marginLeft: '2px' }}>
              <span className="model-status-dot" />
              <span className="model-status-text">{statusLabel}</span>
            </span>
          </div>
          
          <div className="composer-actions-right">
            {activeSession.provider === 'codex' && (
              <div className="context-meter" style={{ ['--context-progress' as string]: `${contextPercentClamped}%` }}>
                <div className="context-ring" aria-label="Context usage">
                  <span className="context-ring-text">
                    {contextPercent === null ? '·' : `${Math.round(contextPercentClamped)}%`}
                  </span>
                </div>
                <div className="context-tooltip" role="status">
                  <div className="context-tooltip-title">Context Usage</div>
                  {!contextUsage && (
                    <div className="context-tooltip-empty">Waiting for token usage data...</div>
                  )}
                  {contextUsage && (
                    <>
                      <div className="context-tooltip-line">
                        <span>Used</span>
                        <strong>{contextPercentText}</strong>
                      </div>
                      <div className="context-tooltip-line">
                        <span>Tokens</span>
                        <strong>
                          {formatTokenCount(usedTokens)}
                          {maxTokens ? ` / ${formatTokenCount(maxTokens)}` : ''}
                        </strong>
                      </div>
                      <div className="context-tooltip-line">
                        <span>Last turn</span>
                        <strong>{formatTokenCount(lastTurnTokens)}</strong>
                      </div>
                      <div className="context-tooltip-line">
                        <span>Input / Output</span>
                        <strong>
                          {formatTokenCount(totalInputTokens)} / {formatTokenCount(totalOutputTokens)}
                        </strong>
                      </div>
                      <div className="context-tooltip-line">
                        <span>Cached / Reasoning</span>
                        <strong>
                          {formatTokenCount(totalCachedInputTokens)} / {formatTokenCount(totalReasoningOutputTokens)}
                        </strong>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
            {isCurrentSessionRunning && (
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
              disabled={!input.trim() && images.length === 0}
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
