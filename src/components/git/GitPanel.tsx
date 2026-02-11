import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Download, FileCode, FolderSearch, MoreHorizontal, RefreshCw, Undo2, Upload } from 'lucide-react';
import { html as diffToHtml } from 'diff2html';
import 'diff2html/bundles/css/diff2html.min.css';
import { useAppStore } from '../../store';
import type { GitFileDiffResponse, GitFileStatus, GitStatusResponse } from '../../types';
import {
  discardGitFile,
  getGitFileDiff,
  getGitStatus,
  stageGitFile,
  unstageGitFile,
} from '../../services/tauri';

type GitTab = 'unstaged' | 'staged';

function renderPatch(patch: string | null): string | null {
  if (!patch || !patch.trim()) return null;
  try {
    return diffToHtml(patch, {
      drawFileList: false,
      matching: 'lines',
      outputFormat: 'line-by-line',
      diffStyle: 'word',
      renderNothingWhenEmpty: true,
    });
  } catch (error) {
    console.error('Failed to render patch:', error);
    return null;
  }
}

export function GitPanel() {
  const { activeProjectId, showGitPanel } = useAppStore();

  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [activeTab, setActiveTab] = useState<GitTab>('unstaged');
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [diffs, setDiffs] = useState<Record<string, GitFileDiffResponse>>({});
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [loadingDiffs, setLoadingDiffs] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const hasAutoExpandedRef = useRef(false);

  const unstagedFiles = useMemo(() => 
    status?.files.filter(f => f.unstaged || f.untracked) ?? [], 
    [status?.files]
  );
  const stagedFiles = useMemo(() => 
    status?.files.filter(f => f.staged) ?? [], 
    [status?.files]
  );

  const currentFiles = activeTab === 'unstaged' ? unstagedFiles : stagedFiles;

  useEffect(() => {
    hasAutoExpandedRef.current = false;
    setExpandedFiles(new Set());
    setDiffs({});
  }, [activeProjectId]);

  const loadStatus = useCallback(async () => {
    if (!activeProjectId) {
      setStatus(null);
      setDiffs({});
      hasAutoExpandedRef.current = false;
      return;
    }

    setLoadingStatus(true);
    setError(null);
    try {
      const next = await getGitStatus(activeProjectId);
      setStatus(next);
      // Auto-expand only once per project switch.
      if (next.files.length > 0 && !hasAutoExpandedRef.current) {
        setExpandedFiles(new Set([next.files[0].path]));
        hasAutoExpandedRef.current = true;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load git status');
    } finally {
      setLoadingStatus(false);
    }
  }, [activeProjectId]);

  useEffect(() => {
    if (!showGitPanel) return;
    void loadStatus();
  }, [loadStatus, showGitPanel]);

  const loadDiff = useCallback(async (path: string) => {
    if (!activeProjectId) return;
    setLoadingDiffs(prev => new Set(prev).add(path));
    try {
      const diff = await getGitFileDiff(activeProjectId, path);
      setDiffs(prev => ({ ...prev, [path]: diff }));
    } catch (err) {
      console.error(`Failed to load diff for ${path}:`, err);
    } finally {
      setLoadingDiffs(prev => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }, [activeProjectId]);

  useEffect(() => {
    for (const path of expandedFiles) {
      if (!diffs[path] && !loadingDiffs.has(path)) {
        void loadDiff(path);
      }
    }
  }, [diffs, expandedFiles, loadDiff, loadingDiffs]);

  const toggleExpand = useCallback((path: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!diffs[path]) {
          void loadDiff(path);
        }
      }
      return next;
    });
  }, [diffs, loadDiff]);

  const runAction = useCallback(
    async (file: GitFileStatus, action: 'stage' | 'unstage' | 'discard') => {
      if (!activeProjectId) return;
      const key = `${action}:${file.path}`;
      setActionKey(key);
      setError(null);
      try {
        if (action === 'stage') {
          await stageGitFile(activeProjectId, file.path);
        } else if (action === 'unstage') {
          await unstageGitFile(activeProjectId, file.path);
        } else {
          const confirmed = window.confirm(`Discard all changes for "${file.path}"?`);
          if (!confirmed) return;
          await discardGitFile(activeProjectId, file.path, file.untracked);
        }
        setDiffs({});
        setLoadingDiffs(new Set());
        await loadStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Git action failed');
      } finally {
        setActionKey(null);
      }
    },
    [activeProjectId, loadStatus]
  );

  const runBulkAction = useCallback(
    async (action: 'stageAll' | 'revertAll') => {
      if (!activeProjectId || !status) return;

      const files = action === 'stageAll'
        ? status.files.filter((file) => file.unstaged || file.untracked)
        : status.files;

      if (files.length === 0) return;

      if (action === 'revertAll') {
        const confirmed = window.confirm(`Revert all changes for ${files.length} file(s)? This cannot be undone.`);
        if (!confirmed) return;
      }

      const key = action === 'stageAll' ? 'bulk:stage-all' : 'bulk:revert-all';
      setActionKey(key);
      setError(null);
      try {
        for (const file of files) {
          if (action === 'stageAll') {
            await stageGitFile(activeProjectId, file.path);
          } else {
            await discardGitFile(activeProjectId, file.path, file.untracked);
          }
        }
        setDiffs({});
        setLoadingDiffs(new Set());
        await loadStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Git action failed');
      } finally {
        setActionKey(null);
      }
    },
    [activeProjectId, loadStatus, status]
  );

  const isBusy = loadingStatus || actionKey !== null;
  const canStageAll = unstagedFiles.length > 0;
  const canRevertAll = (status?.files.length ?? 0) > 0;

  if (!showGitPanel) return null;

  return (
    <aside className="git-panel">
      <div className="git-panel-header-v2">
        <div className="header-top">
          <div className="view-selector">
            <span>Uncommitted changes</span>
            <ChevronDown size={14} />
          </div>
          <div className="header-tabs">
            <button 
              className={`tab-btn ${activeTab === 'unstaged' ? 'active' : ''}`}
              onClick={() => setActiveTab('unstaged')}
            >
              Unstaged {unstagedFiles.length > 0 && <span className="tab-count">{unstagedFiles.length}</span>}
            </button>
            <button 
              className={`tab-btn ${activeTab === 'staged' ? 'active' : ''}`}
              onClick={() => setActiveTab('staged')}
            >
              Staged {stagedFiles.length > 0 && <span className="tab-count">{stagedFiles.length}</span>}
            </button>
          </div>
          <div className="header-actions-right">
            <button className="git-icon-btn"><FileCode size={15} /></button>
            <button className="git-icon-btn"><MoreHorizontal size={15} /></button>
          </div>
        </div>
      </div>

      <div className="git-panel-content">
        {!activeProjectId && (
          <div className="git-empty-state">
            <div className="empty-state-card">
              <FolderSearch size={32} strokeWidth={1.5} className="empty-icon" />
              <h3>No project selected</h3>
              <p>Select a project from the sidebar to inspect its git status and changes.</p>
            </div>
          </div>
        )}

        {activeProjectId && status?.is_git_repo && currentFiles.length === 0 && (
          <div className="git-empty-state">
            <div className="empty-state-card">
              <CheckCircle2 size={32} strokeWidth={1.5} className="empty-icon success" />
              <h3>All clear</h3>
              <p>No {activeTab} changes found. Your working tree is clean.</p>
            </div>
          </div>
        )}

        {error && (
          <div className="git-error-banner">{error}</div>
        )}

        <div className="git-unified-list">
          {currentFiles.map((file) => {
            const isExpanded = expandedFiles.has(file.path);
            const diff = diffs[file.path];
            const patch = activeTab === 'staged' ? diff?.staged_patch : diff?.unstaged_patch;
            const diffHtml = renderPatch(patch ?? null);
            const hasPatchContent = Boolean(patch && patch.trim());
            const isLoading = loadingDiffs.has(file.path);

            return (
              <div key={file.path} className={`git-file-block ${isExpanded ? 'expanded' : ''}`}>
                <div className="file-header" onClick={() => toggleExpand(file.path)}>
                  <div className="header-left">
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span className="file-path">{file.path}</span>
                    <span className="file-stats">
                      {/* Placeholder for stats if available */}
                      <span className="plus">+201</span>
                      <span className="minus">-141</span>
                    </span>
                  </div>
                  <div className="header-right">
                    <button 
                      className="mini-action-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        void runAction(file, activeTab === 'unstaged' ? 'stage' : 'unstage');
                      }}
                      disabled={isBusy}
                    >
                      {activeTab === 'unstaged' ? <Upload size={12} /> : <Download size={12} />}
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="file-diff-body">
                    {isLoading && (
                      <div className="diff-loading">
                        <RefreshCw size={14} className="spinning" />
                        <span>Loading diff...</span>
                      </div>
                    )}
                    {!isLoading && !diffHtml && !hasPatchContent && (
                      <div className="diff-empty">Binary or empty changes</div>
                    )}
                    {!isLoading && !diffHtml && hasPatchContent && (
                      <div className="diff-empty">Unable to render diff</div>
                    )}
                    {!isLoading && diffHtml && (
                      <div 
                        className="diff-rendered"
                        dangerouslySetInnerHTML={{ __html: diffHtml }}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="git-panel-footer-pill">
        <button
          className="footer-btn"
          onClick={() => {
            void runBulkAction('revertAll');
          }}
          disabled={isBusy || !canRevertAll}
        >
          <Undo2 size={14} />
          <span>Revert all</span>
        </button>
        <button
          className="footer-btn primary"
          onClick={() => {
            void runBulkAction('stageAll');
          }}
          disabled={isBusy || !canStageAll}
        >
          <Upload size={14} />
          <span>Stage all</span>
        </button>
      </div>
    </aside>
  );
}
