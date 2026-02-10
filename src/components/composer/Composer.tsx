import { useState, useRef, useEffect } from 'react';
import { Square, Plus, Mic, ChevronDown, X } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useAppStore } from '../../store';
import * as api from '../../services/tauri';
import { t } from '../../i18n';
import { MODEL_OPTIONS_BY_PROVIDER, getSessionModelLabel } from '../../constants/models';

function getFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return segments[segments.length - 1] || path;
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
    isSending,
    sendMessage,
    stopSession,
    setSessionModel,
  } = useAppStore();
  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
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
    setImages([]);
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
    if ((!input.trim() && images.length === 0) || !activeSessionId) return;
    const text = input.trim();
    const imageMarkdown = images
      .map((path) => `[Image: ${path}]`)
      .join('\n');
    const msg = [text, imageMarkdown].filter(Boolean).join('\n\n');
    setInput('');
    setImages([]);
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
            <div className="model-selector-wrap" ref={modelMenuRef}>
              <button
                className="icon-btn model-btn"
                style={{ gap: '6px', paddingRight: '8px', fontSize: '12px' }}
                onClick={() => setShowModelMenu((prev) => !prev)}
              >
                <span className="model-label">{modelLabel}</span>
                <span className={`model-status ${statusClassName}`}>
                  <span className="model-status-dot" />
                  <span className="model-status-text">{statusLabel}</span>
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
