import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  GitBranch,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  X,
  ArrowDownToLine,
  ArrowUpToLine,
  FileDiff,
  Quote,
  AtSign
} from 'lucide-react';
import { apiFetch } from './api.js';
import { GitHistoryPanel } from './git-history-panel.jsx';
import { GitDiffViewer } from './git-diff-viewer.jsx';
import { SessionHistoryPanel } from './session-history-panel.jsx';
import './git-panel.css';

const SECTIONS = [
  { key: 'staged', label: '已暂存', stagedFlag: 1 },
  { key: 'modified', label: '已修改', stagedFlag: 0 },
  { key: 'untracked', label: '未跟踪', stagedFlag: 0 }
];

// classifyDiffLine + inline <DiffView> moved into ./git-diff-viewer.jsx so
// the same renderer powers worktree, staged, and commit-mode diffs and the
// selection-capture logic stays in one place.

function FilesSection({ title, files, expanded, onToggle, onSelect, selectedSet, onToggleSelect, onToggleSection }) {
  const allSelected = files.length > 0 && files.every((f) => selectedSet?.has(f));
  const noneSelected = files.length === 0 || files.every((f) => !selectedSet?.has(f));
  return (
    <div className="files-section">
      <button type="button" className="files-section-header" onClick={onToggle}>
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <strong>{title}</strong>
        <span className="files-count">{files.length}</span>
      </button>
      {expanded && files.length > 0 && (
        <>
          <div className="files-section-actions">
            <button
              type="button"
              className="ghost-btn small"
              onClick={(e) => { e.stopPropagation(); onToggleSection?.(allSelected ? 'none' : 'all'); }}
            >
              {allSelected ? '全部取消' : noneSelected ? '全部选择' : '反选'}
            </button>
          </div>
          <ul className="files-list">
            {files.map((file) => {
              const checked = selectedSet?.has(file) || false;
              return (
                <li key={file} className={`file-row-wrap ${checked ? 'is-selected' : ''}`}>
                  <input
                    type="checkbox"
                    className="file-check"
                    checked={checked}
                    onChange={() => onToggleSelect?.(file)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`选择 ${file}`}
                  />
                  <button
                    type="button"
                    className="file-row"
                    onClick={() => onSelect(file)}
                    title={file}
                  >
                    <FileDiff size={14} />
                    <span>{file}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {expanded && files.length === 0 && (
        <div className="files-empty">无文件</div>
      )}
    </div>
  );
}

export function GitPanel({ project, onClose, onInsertIntoComposer, onSelectSession, peers = [], currentAgent = null }) {
  const [tab, setTab] = useState('status'); // 'status' | 'history'
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState({ staged: true, modified: true, untracked: false });
  const [diffFile, setDiffFile] = useState(null); // { file, staged, commit, diff, loading, error }
  const [diffSelection, setDiffSelection] = useState(null); // { file, commit, startLine, endLine, text }
  // Read-only preview of a session before committing to switch the chat
  // (mindfs-style preview→confirm). null when no badge is open.
  const [previewSession, setPreviewSession] = useState(null);
  const [showCommit, setShowCommit] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [addAll, setAddAll] = useState(true);
  const [selectedFiles, setSelectedFiles] = useState(() => new Set());
  const [pullBusy, setPullBusy] = useState(false);
  const [commitBusy, setCommitBusy] = useState(false);
  const [actionResult, setActionResult] = useState(null); // { kind, ...payload }

  const projectId = project?.id;

  const loadStatus = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch(`/api/git/status?projectId=${encodeURIComponent(projectId)}`);
      setStatus(data);
    } catch (err) {
      setError(err?.message || '获取状态失败');
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const fileStagedFlag = useCallback(
    (file) => (status && status.staged && status.staged.includes(file) ? 1 : 0),
    [status]
  );

  const openDiff = useCallback(
    async (file) => {
      const staged = fileStagedFlag(file);
      setDiffFile({ file, staged, diff: '', loading: true, error: '' });
      try {
        const params = new URLSearchParams({
          projectId,
          file,
          staged: String(staged)
        });
        const data = await apiFetch(`/api/git/diff?${params.toString()}`);
        setDiffFile({ file, staged, diff: data?.diff || '', loading: false, error: '' });
      } catch (err) {
        setDiffFile({
          file,
          staged,
          diff: '',
          loading: false,
          error: err?.message || '获取差异失败'
        });
      }
    },
    [projectId, fileStagedFlag]
  );

  const openCommitDiff = useCallback(
    async (commit, file) => {
      if (!projectId || !commit?.hash || !file?.path) return;
      setDiffFile({
        file: file.path,
        commit: commit.hash,
        staged: 0,
        diff: '',
        loading: true,
        error: ''
      });
      try {
        const params = new URLSearchParams({
          projectId,
          commit: commit.hash,
          file: file.path
        });
        const data = await apiFetch(`/api/git/diff?${params.toString()}`);
        setDiffFile({
          file: file.path,
          commit: commit.hash,
          staged: 0,
          diff: data?.diff || '',
          loading: false,
          error: ''
        });
      } catch (err) {
        setDiffFile({
          file: file.path,
          commit: commit.hash,
          staged: 0,
          diff: '',
          loading: false,
          error: err?.message || '获取差异失败'
        });
      }
    },
    [projectId]
  );

  const closeDiff = useCallback(() => {
    setDiffFile(null);
    setDiffSelection(null);
  }, []);

  const insertRef = useCallback(() => {
    if (!diffFile || !onInsertIntoComposer) return;
    const tag = diffFile.commit
      ? `@${diffFile.file}#${String(diffFile.commit).slice(0, 7)}`
      : `@${diffFile.file}`;
    onInsertIntoComposer(tag);
  }, [diffFile, onInsertIntoComposer]);

  const insertSelection = useCallback(() => {
    if (!diffSelection || !diffSelection.text || !onInsertIntoComposer) return;
    // Header lives *outside* the diff fence — putting a `//` line inside
    // would muddy the diff syntax (line doesn't start with +, -, or space,
    // so renderers treat it as plain context which is misleading).
    const ref = diffSelection.commit
      ? `${diffSelection.file}#${String(diffSelection.commit).slice(0, 7)}`
      : diffSelection.file;
    const lineRange = `L${diffSelection.startLine}-${diffSelection.endLine}`;
    const quoted = [
      `> 引自 ${ref} ${lineRange}：`,
      '```diff',
      diffSelection.text.replace(/\s+$/, ''),
      '```'
    ].join('\n');
    onInsertIntoComposer(quoted);
  }, [diffSelection, onInsertIntoComposer]);

  const toggleSection = useCallback((key) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handlePull = useCallback(async () => {
    if (!projectId || pullBusy) return;
    if (status?.dirty) return;
    if (!window.confirm('确认从远端拉取最新提交？')) return;
    setPullBusy(true);
    setError('');
    setActionResult(null);
    try {
      const data = await apiFetch('/api/git/pull', {
        method: 'POST',
        body: { projectId }
      });
      setActionResult({ kind: 'pull', ...data });
      await loadStatus();
    } catch (err) {
      setError(err?.message || '拉取失败');
    } finally {
      setPullBusy(false);
    }
  }, [projectId, pullBusy, status, loadStatus]);

  const toggleSelectFile = useCallback((file) => {
    setSelectedFiles((current) => {
      const next = new Set(current);
      if (next.has(file)) next.delete(file); else next.add(file);
      return next;
    });
  }, []);

  const toggleSectionSelection = useCallback((sectionKey, mode) => {
    if (!status) return;
    const files = status[sectionKey] || [];
    setSelectedFiles((current) => {
      const next = new Set(current);
      if (mode === 'all') for (const f of files) next.add(f);
      else for (const f of files) next.delete(f);
      return next;
    });
  }, [status]);

  const handleCommitPush = useCallback(
    async (event) => {
      event?.preventDefault?.();
      if (!projectId || commitBusy) return;
      const message = commitMessage.trim();
      if (!message) {
        setError('提交说明不能为空');
        return;
      }
      setCommitBusy(true);
      setError('');
      setActionResult(null);
      try {
        const paths = selectedFiles.size > 0 ? [...selectedFiles] : undefined;
        const body = { projectId, message };
        if (paths) body.paths = paths;
        else body.addAll = addAll;
        const data = await apiFetch('/api/git/commit-push', { method: 'POST', body });
        setActionResult({ kind: 'commit', ...data });
        setShowCommit(false);
        setCommitMessage('');
        setSelectedFiles(new Set());
        await loadStatus();
      } catch (err) {
        setError(err?.message || '提交失败');
      } finally {
        setCommitBusy(false);
      }
    },
    [projectId, commitBusy, commitMessage, addAll, selectedFiles, loadStatus]
  );

  const totalChanges =
    (status?.staged?.length || 0) +
    (status?.modified?.length || 0) +
    (status?.untracked?.length || 0);

  return (
    <div className="git-panel" role="dialog" aria-label="Git 操作">
      <div className="header">
        <div className="header-title">
          <GitBranch size={18} />
          <strong>{project?.name || '项目'}</strong>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="ghost-btn"
            onClick={loadStatus}
            disabled={loading}
            title="刷新"
          >
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
            <span>刷新</span>
          </button>
          {onClose && (
            <button type="button" className="ghost-btn icon-only" onClick={onClose} title="关闭">
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {project?.path && <div className="path-row" title={project.path}>{project.path}</div>}

      <div className="git-tabs" role="tablist" aria-label="Git 视图">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'status'}
          className={`git-tab ${tab === 'status' ? 'is-active' : ''}`}
          onClick={() => setTab('status')}
        >
          状态
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'history'}
          className={`git-tab ${tab === 'history' ? 'is-active' : ''}`}
          onClick={() => setTab('history')}
        >
          历史
        </button>
      </div>

      {tab === 'history' ? (
        <GitHistoryPanel project={project} onSelectCommitFile={openCommitDiff} />
      ) : (
        <>
      {error && (
        <div className="banner-error" role="alert">
          <span>{error}</span>
          <div className="banner-actions">
            <button type="button" className="ghost-btn small" onClick={loadStatus}>
              重试
            </button>
            <button
              type="button"
              className="ghost-btn icon-only small"
              onClick={() => setError('')}
              title="关闭"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {loading && !status ? (
        <div className="git-loading">
          <RefreshCw size={20} className="spin" />
          <span>加载中…</span>
        </div>
      ) : status ? (
        <>
          <div className="branch-row">
            <span className="branch-chip">
              <GitBranch size={14} />
              {status.branch || '(detached)'}
            </span>
            {status.ahead > 0 && (
              <span className="chip chip-ahead" title="本地领先">↑{status.ahead}</span>
            )}
            {status.behind > 0 && (
              <span className="chip chip-behind" title="远端领先">↓{status.behind}</span>
            )}
            <span className={`chip ${status.dirty ? 'chip-dirty' : 'chip-clean'}`}>
              {status.dirty ? `${totalChanges} 处改动` : '干净'}
            </span>
          </div>

          {actionResult && (
            <div className="banner-success">
              {actionResult.kind === 'pull' ? (
                <span>拉取完成{actionResult.success === false ? '（含警告）' : ''}</span>
              ) : (
                <span>
                  {actionResult.committed ? '已提交' : '无新提交'}
                  {actionResult.pushed ? ' · 已推送' : ''}
                  {actionResult.sha ? ` · ${String(actionResult.sha).slice(0, 7)}` : ''}
                </span>
              )}
              <button
                type="button"
                className="ghost-btn icon-only small"
                onClick={() => setActionResult(null)}
                title="关闭"
              >
                <X size={14} />
              </button>
            </div>
          )}

          <div className="sections">
            {SECTIONS.map((section) => (
              <FilesSection
                key={section.key}
                title={section.label}
                files={status[section.key] || []}
                expanded={!!expanded[section.key]}
                onToggle={() => toggleSection(section.key)}
                onSelect={openDiff}
                selectedSet={selectedFiles}
                onToggleSelect={toggleSelectFile}
                onToggleSection={(mode) => toggleSectionSelection(section.key, mode)}
              />
            ))}
          </div>

          {showCommit && (
            <form className="commit-form" onSubmit={handleCommitPush}>
              <label className="commit-label">提交说明</label>
              <textarea
                className="commit-textarea"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="例如：修复登录页面样式"
                rows={3}
                disabled={commitBusy}
              />
              {selectedFiles.size > 0 ? (
                <div className="commit-paths-note">
                  仅提交所选 <strong>{selectedFiles.size}</strong> 个文件
                  <button
                    type="button"
                    className="ghost-btn small"
                    onClick={() => setSelectedFiles(new Set())}
                    disabled={commitBusy}
                    style={{ marginLeft: 8 }}
                  >
                    清空选择
                  </button>
                </div>
              ) : (
                <label className="commit-checkbox">
                  <input
                    type="checkbox"
                    checked={addAll}
                    onChange={(e) => setAddAll(e.target.checked)}
                    disabled={commitBusy}
                  />
                  <span>全部添加（未选中文件时）</span>
                </label>
              )}
              <div className="commit-form-actions">
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => setShowCommit(false)}
                  disabled={commitBusy}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="primary-btn"
                  disabled={commitBusy || !commitMessage.trim()}
                >
                  {commitBusy ? '处理中…' : '确认推送'}
                </button>
              </div>
            </form>
          )}

          <div className="action-bar">
            <button
              type="button"
              className="primary-btn"
              onClick={handlePull}
              disabled={pullBusy || !!status.dirty}
              title={status.dirty ? '有未提交改动，无法拉取' : '从远端拉取'}
            >
              <ArrowDownToLine size={16} />
              <span>{pullBusy ? '拉取中…' : 'Pull'}</span>
            </button>
            <button
              type="button"
              className="primary-btn accent"
              onClick={() => setShowCommit((v) => !v)}
              disabled={commitBusy}
            >
              <ArrowUpToLine size={16} />
              <span>Commit &amp; Push</span>
            </button>
          </div>
        </>
      ) : null}
        </>
      )}

      {previewSession ? (
        <SessionHistoryPanel
          session={previewSession}
          onClose={() => setPreviewSession(null)}
          onRestore={onSelectSession ? (session) => {
            setPreviewSession(null);
            onSelectSession(session);
          } : undefined}
        />
      ) : null}

      {diffFile && (
        <div className="diff-modal-backdrop" onClick={closeDiff}>
          <div
            className="diff-modal"
            role="dialog"
            aria-label="文件差异"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="diff-modal-header">
              <span className="diff-modal-title" title={diffFile.file}>
                <FileDiff size={14} />
                <strong>{diffFile.file}</strong>
              </span>
              <div className="diff-modal-actions">
                {onInsertIntoComposer && diffFile.diff ? (
                  <>
                    <button
                      type="button"
                      className="ghost-btn small"
                      onClick={insertSelection}
                      disabled={!diffSelection || !diffSelection.text}
                      title={diffSelection?.text ? '把所选行作为引用插入对话' : '先在差异里选中文本'}
                    >
                      <Quote size={14} />
                      <span>引用选区</span>
                    </button>
                    <button
                      type="button"
                      className="ghost-btn small"
                      onClick={insertRef}
                      title="把文件路径作为 @ 引用插入对话"
                    >
                      <AtSign size={14} />
                      <span>引用路径</span>
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  className="ghost-btn icon-only"
                  onClick={closeDiff}
                  title="关闭"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="diff-modal-body">
              {diffFile.loading ? (
                <div className="git-loading">
                  <RefreshCw size={18} className="spin" />
                  <span>加载差异…</span>
                </div>
              ) : diffFile.error ? (
                <div className="banner-error">
                  <span>{diffFile.error}</span>
                  <button
                    type="button"
                    className="ghost-btn small"
                    onClick={() => openDiff(diffFile.file)}
                  >
                    重试
                  </button>
                </div>
              ) : diffFile.diff ? (
                <GitDiffViewer
                  diff={diffFile.diff}
                  file={diffFile.file}
                  commit={diffFile.commit}
                  staged={diffFile.staged}
                  projectId={projectId}
                  peers={peers}
                  currentAgent={currentAgent}
                  onSelectionChange={setDiffSelection}
                  onSelectSession={onSelectSession ? setPreviewSession : undefined}
                />
              ) : (
                <div className="files-empty">无差异内容</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default GitPanel;
