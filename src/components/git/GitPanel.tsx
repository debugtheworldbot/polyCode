import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, GitBranch, RefreshCw, Undo2, Upload } from 'lucide-react';
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

type BadgeTone = 'added' | 'modified' | 'deleted' | 'conflict';

function statusCode(file: GitFileStatus): string {
  if (file.untracked) return '??';
  return `${file.index_status}${file.worktree_status}`;
}

function statusTone(file: GitFileStatus): BadgeTone {
  const code = statusCode(file);
  if (file.conflicted) return 'conflict';
  if (code.includes('D')) return 'deleted';
  if (file.untracked || code.includes('A')) return 'added';
  return 'modified';
}

function renderPatch(patch: string | null): string | null {
  if (!patch || !patch.trim()) return null;
  try {
    return diffToHtml(patch, {
      drawFileList: false,
      matching: 'lines',
      outputFormat: 'line-by-line',
      diffStyle: 'word',
    });
  } catch (error) {
    console.error('Failed to render patch:', error);
    return null;
  }
}

export function GitPanel() {
  const { activeProjectId, projects, showGitPanel } = useAppStore();

  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitFileDiffResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const files = status?.files ?? [];
  const selectedFile = selectedPath ? files.find((f) => f.path === selectedPath) ?? null : null;

  const loadStatus = useCallback(async () => {
    if (!activeProjectId) {
      setStatus(null);
      setSelectedPath(null);
      setDiff(null);
      return;
    }

    setLoadingStatus(true);
    setError(null);
    try {
      const next = await getGitStatus(activeProjectId);
      setStatus(next);
      setSelectedPath((prev) => {
        if (next.files.length === 0) return null;
        if (prev && next.files.some((file) => file.path === prev)) return prev;
        return next.files[0].path;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load git status';
      setError(message);
    } finally {
      setLoadingStatus(false);
    }
  }, [activeProjectId]);

  useEffect(() => {
    if (!showGitPanel) return;
    void loadStatus();
  }, [loadStatus, showGitPanel]);

  useEffect(() => {
    if (!showGitPanel || !activeProjectId || !selectedPath) {
      setDiff(null);
      return;
    }

    let cancelled = false;
    setLoadingDiff(true);
    setError(null);

    void getGitFileDiff(activeProjectId, selectedPath)
      .then((payload) => {
        if (!cancelled) setDiff(payload);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load git diff';
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoadingDiff(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeProjectId, selectedPath, showGitPanel]);

  const stagedHtml = useMemo(() => renderPatch(diff?.staged_patch ?? null), [diff?.staged_patch]);
  const unstagedHtml = useMemo(() => renderPatch(diff?.unstaged_patch ?? null), [diff?.unstaged_patch]);

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
          const confirmed = window.confirm(
            `Discard all changes for "${file.path}"? This cannot be undone.`
          );
          if (!confirmed) return;
          await discardGitFile(activeProjectId, file.path, file.untracked);
        }

        await loadStatus();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Git action failed';
        setError(message);
      } finally {
        setActionKey(null);
      }
    },
    [activeProjectId, loadStatus]
  );

  if (!showGitPanel) return null;

  return (
    <aside className="git-panel">
      <div className="git-panel-header">
        <div className="git-panel-title">
          <GitBranch size={15} />
          <span>Git Changes</span>
          <span className="git-panel-count">{files.length}</span>
        </div>
        <button
          className="git-icon-btn"
          title="Refresh git status"
          onClick={() => void loadStatus()}
          disabled={loadingStatus}
        >
          <RefreshCw size={14} className={loadingStatus ? 'spinning' : ''} />
        </button>
      </div>

      <div className="git-panel-meta">
        <span className="git-branch-name">
          {status?.is_git_repo ? (status.branch || '(detached HEAD)') : 'Not a git repository'}
        </span>
        {!!status?.is_git_repo && (
          <span className="git-branch-stats">
            {status.ahead > 0 ? `ahead ${status.ahead}` : ''}
            {status.ahead > 0 && status.behind > 0 ? ' / ' : ''}
            {status.behind > 0 ? `behind ${status.behind}` : ''}
            {status.ahead === 0 && status.behind === 0 ? 'up to date' : ''}
          </span>
        )}
      </div>

      {activeProject && (
        <div className="git-project-path" title={activeProject.path}>
          {activeProject.path}
        </div>
      )}

      {error && (
        <div className="git-panel-error">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      <div className="git-panel-body">
        <section className="git-files-section">
          {!activeProjectId && (
            <div className="git-empty">Select a project to inspect git changes.</div>
          )}

          {activeProjectId && status && !status.is_git_repo && (
            <div className="git-empty">Current project is not a git repository.</div>
          )}

          {activeProjectId && status?.is_git_repo && files.length === 0 && (
            <div className="git-empty">Working tree clean.</div>
          )}

          <div className="git-file-list">
            {files.map((file) => {
              const tone = statusTone(file);
              const selected = file.path === selectedPath;
              const stageKey = `stage:${file.path}`;
              const unstageKey = `unstage:${file.path}`;
              const discardKey = `discard:${file.path}`;

              return (
                <div
                  key={`${file.path}:${file.old_path ?? ''}`}
                  className={`git-file-item ${selected ? 'active' : ''}`}
                  onClick={() => setSelectedPath(file.path)}
                >
                  <div className="git-file-main">
                    <span className={`git-status-pill tone-${tone}`}>{statusCode(file)}</span>
                    <div className="git-file-labels">
                      <span className="git-file-path" title={file.path}>{file.path}</span>
                      {file.old_path && (
                        <span className="git-file-old-path" title={file.old_path}>
                          from {file.old_path}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="git-file-actions" onClick={(e) => e.stopPropagation()}>
                    {(file.unstaged || file.untracked) && (
                      <button
                        className="git-mini-btn"
                        title="Stage"
                        disabled={actionKey === stageKey}
                        onClick={() => void runAction(file, 'stage')}
                      >
                        <Upload size={12} />
                      </button>
                    )}
                    {file.staged && (
                      <button
                        className="git-mini-btn"
                        title="Unstage"
                        disabled={actionKey === unstageKey}
                        onClick={() => void runAction(file, 'unstage')}
                      >
                        <Download size={12} />
                      </button>
                    )}
                    <button
                      className="git-mini-btn danger"
                      title="Discard changes"
                      disabled={actionKey === discardKey}
                      onClick={() => void runAction(file, 'discard')}
                    >
                      <Undo2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="git-diff-section">
          {!selectedFile && (
            <div className="git-empty">Select a changed file to view diff.</div>
          )}

          {selectedFile && (
            <div className="git-diff-content">
              <div className="git-diff-title">{selectedFile.path}</div>
              {loadingDiff && <div className="git-empty">Loading diff…</div>}

              {!loadingDiff && !stagedHtml && !unstagedHtml && (
                <div className="git-empty">No textual diff available for this file.</div>
              )}

              {!loadingDiff && stagedHtml && (
                <div className="git-diff-block">
                  <div className="git-diff-block-title">Staged</div>
                  <div
                    className="git-diff-render"
                    dangerouslySetInnerHTML={{ __html: stagedHtml }}
                  />
                </div>
              )}

              {!loadingDiff && unstagedHtml && (
                <div className="git-diff-block">
                  <div className="git-diff-block-title">Unstaged</div>
                  <div
                    className="git-diff-render"
                    dangerouslySetInnerHTML={{ __html: unstagedHtml }}
                  />
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
