import { useEffect, useState } from 'react';
import { FileDiff, RefreshCw, X, RotateCw } from 'lucide-react';

import { apiFetch } from './api.js';

const STATUS_LABEL = {
  add: '新增',
  update: '修改',
  delete: '删除'
};

function shortHash(value) {
  if (!value) return '';
  return String(value).slice(0, 8);
}

function formatTimestamp(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${da} ${h}:${mi}`;
}

// Trim a long absolute path to a project-relative display, falling back
// to the leaf when cwd is unknown.
function displayRelPath(absPath, cwd) {
  if (!absPath) return '';
  if (cwd) {
    const a = absPath.replace(/\\/g, '/');
    const c = cwd.replace(/\\/g, '/');
    if (a.toLowerCase().startsWith(c.toLowerCase() + '/')) {
      return a.slice(c.length + 1);
    }
    if (a.toLowerCase() === c.toLowerCase()) {
      return '.';
    }
  }
  return absPath;
}

// Read-only preview of a session — opens before the user commits to
// switching the chat (mindfs-style attribution → confirm flow). The body
// shows the files this session touched, which is usually enough context
// to decide "yes that's the conversation I was looking for."
export function SessionHistoryPanel({ session, onClose, onRestore }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sessionId = session?.sessionId || null;
  const cwd = session?.cwd || null;

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/files?limit=200`)
      .then((data) => {
        if (cancelled) return;
        setFiles(Array.isArray(data?.files) ? data.files : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || '加载文件列表失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!session) return null;

  return (
    <div className="session-history-backdrop" role="dialog" aria-label="对话历史预览" onClick={onClose}>
      <div className="session-history-panel" onClick={(e) => e.stopPropagation()}>
        <div className="session-history-header">
          <div className="session-history-title">
            <strong>{shortHash(sessionId)}</strong>
            {session.touchedAt ? (
              <span className="session-history-date">{formatTimestamp(session.touchedAt)}</span>
            ) : null}
          </div>
          <button
            type="button"
            className="ghost-btn icon-only"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        {cwd ? <div className="session-history-cwd" title={cwd}>{cwd}</div> : null}

        <div className="session-history-body">
          <div className="session-history-section-label">改过的文件</div>
          {loading ? (
            <div className="git-loading small">
              <RefreshCw size={14} className="spin" />
              <span>加载中…</span>
            </div>
          ) : error ? (
            <div className="banner-error small">
              <span>{error}</span>
            </div>
          ) : files.length === 0 ? (
            // Reachable mostly via future entry points (e.g. a file-tree
            // panel showing all sessions that touched a path); from the
            // "近期改过" badge in GitDiffViewer this branch shouldn't
            // fire because the badge only renders when the session is
            // already in the forward index — same fileStates feed both
            // directions. Surfacing it cleanly anyway.
            <div className="files-empty">这个对话只有问答记录，没有改过文件</div>
          ) : (
            <ul className="session-history-files">
              {files.map((file, idx) => (
                <li key={`${idx}-${file.path}`} className="session-history-file">
                  <FileDiff size={13} aria-hidden="true" />
                  <span className={`status-badge status-${(file.op || 'X')[0].toUpperCase()}`}>
                    {STATUS_LABEL[file.op] || file.op || ''}
                  </span>
                  <span className="session-history-file-path" title={file.path}>
                    {displayRelPath(file.path, cwd)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="session-history-actions">
          <button type="button" className="ghost-btn" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="primary-btn"
            onClick={() => onRestore?.(session)}
            disabled={!onRestore}
          >
            <RotateCw size={14} />
            <span>恢复对话</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default SessionHistoryPanel;
