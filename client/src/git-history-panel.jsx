import { useCallback, useEffect, useRef, useState } from 'react';
import { GitCommit, ChevronDown, ChevronRight, RefreshCw, FileDiff } from 'lucide-react';
import { apiFetch } from './api.js';

const STATUS_LABEL = {
  A: '新增',
  M: '修改',
  D: '删除',
  R: '改名',
  C: '复制',
  T: '类型变化',
  U: '未合并'
};

function statusLabel(status) {
  if (!status) return '';
  const head = status[0];
  return STATUS_LABEL[head] || status;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${da} ${h}:${mi}`;
}

export function GitHistoryPanel({ project, onSelectCommitFile }) {
  const [commits, setCommits] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  // Per-commit file expansion state.
  // Map<hash, { loading, error, files }>
  const [filesByHash, setFilesByHash] = useState({});
  // Sentinel used by IntersectionObserver to auto-load the next page when
  // the user scrolls near the bottom of the timeline. Explicit "加载更多"
  // button stays as a keyboard-accessible fallback (and for browsers
  // without IntersectionObserver — though that's vanishingly rare).
  const sentinelRef = useRef(null);
  // Latest loadPage closure — the observer effect captures by ref so we
  // don't have to rebind the observer every time cursor / commits change.
  const loadPageRef = useRef(null);

  const projectId = project?.id;

  const loadPage = useCallback(
    async ({ reset = false } = {}) => {
      if (!projectId) return;
      const isFirst = reset || commits.length === 0;
      if (isFirst) setLoading(true); else setLoadingMore(true);
      setError('');
      try {
        // includeFiles=1 batches commit-file fetching into the same git log
        // call — eliminates the N+1 per-expand roundtrip noted in
        // scripts/probe-git-history-perf.mjs. Body field is dropped server-
        // side in this mode (we don't render it anyway).
        const params = new URLSearchParams({ projectId, limit: '40', includeFiles: '1' });
        if (!isFirst && cursor) params.set('cursor', cursor);
        const data = await apiFetch(`/api/git/history?${params.toString()}`);
        const incoming = Array.isArray(data?.commits) ? data.commits : [];
        setCommits((current) => {
          if (isFirst) return incoming;
          // De-dupe by hash in case cursor commit appears at top of next page.
          const seen = new Set(current.map((c) => c.hash));
          const merged = [...current];
          for (const c of incoming) if (!seen.has(c.hash)) merged.push(c);
          return merged;
        });
        // Prime filesByHash from the inline files so expand renders instantly
        // without firing /api/git/commit-files. Falls back to that endpoint
        // only when a commit's files were absent from the response (very
        // rare; could happen if server-side parse hits a malformed record).
        setFilesByHash((current) => {
          const next = { ...current };
          for (const c of incoming) {
            if (Array.isArray(c.files) && !next[c.hash]) {
              next[c.hash] = { loading: false, error: '', files: c.files, collapsed: true };
            }
          }
          return next;
        });
        setCursor(data?.nextCursor || null);
        setHasMore(Boolean(data?.nextCursor));
      } catch (err) {
        setError(err?.message || '加载历史失败');
      } finally {
        if (isFirst) setLoading(false); else setLoadingMore(false);
      }
    },
    [projectId, cursor, commits.length]
  );

  useEffect(() => {
    if (!projectId) return;
    setCommits([]);
    setCursor(null);
    setHasMore(false);
    setFilesByHash({});
    loadPage({ reset: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Keep loadPageRef pointed at the latest closure so the observer can fire
  // it without rebinding.
  useEffect(() => {
    loadPageRef.current = loadPage;
  }, [loadPage]);

  // IntersectionObserver auto-loads the next page when the sentinel
  // approaches the viewport. Skipped entirely when there's nothing more
  // to load or when a load is already in flight; reattached when those
  // conditions flip.
  useEffect(() => {
    // Skip when there's nothing to load, when a load is already in flight,
    // OR when the last load errored — otherwise a sentinel parked in
    // viewport after a server hiccup would re-fire loadPage on every render,
    // turning a transient failure into an unbounded retry storm. The user's
    // 重试 button clears `error` (via loadPage's setError('')), which
    // re-attaches the observer naturally.
    if (!hasMore || loading || loadingMore || error) return undefined;
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const node = sentinelRef.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            loadPageRef.current?.();
            break;
          }
        }
      },
      // 200px before the sentinel hits the viewport — gives the next page a
      // head start so a fast scroll doesn't hit the bottom and stall.
      { root: null, rootMargin: '200px', threshold: 0 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, error]);

  const toggleCommit = useCallback(
    async (hash) => {
      setFilesByHash((current) => {
        const existing = current[hash];
        if (existing && !existing.collapsed) {
          // Collapse without dropping cached files.
          return { ...current, [hash]: { ...existing, collapsed: true } };
        }
        if (existing && existing.collapsed) {
          return { ...current, [hash]: { ...existing, collapsed: false } };
        }
        return { ...current, [hash]: { loading: true, error: '', files: [], collapsed: false } };
      });
      // Skip the network fetch if we already have a resolved entry (either
      // from a previous expand or from the inline includeFiles=1 prime).
      // The empty-files case still counts as resolved — refetching would
      // just return [] again.
      const existing = filesByHash[hash];
      if (existing && existing.loading === false) return;
      if (existing && existing.loading) return;
      try {
        const data = await apiFetch(
          `/api/git/commit-files/${encodeURIComponent(hash)}?projectId=${encodeURIComponent(projectId)}`
        );
        setFilesByHash((current) => ({
          ...current,
          [hash]: {
            loading: false,
            error: '',
            files: Array.isArray(data?.files) ? data.files : [],
            collapsed: false
          }
        }));
      } catch (err) {
        setFilesByHash((current) => ({
          ...current,
          [hash]: { loading: false, error: err?.message || '加载文件失败', files: [], collapsed: false }
        }));
      }
    },
    [projectId, filesByHash]
  );

  if (!project) {
    return <div className="git-history-empty">未选择项目</div>;
  }

  return (
    <div className="git-history">
      {error && (
        <div className="banner-error" role="alert">
          <span>{error}</span>
          <button type="button" className="ghost-btn small" onClick={() => loadPage({ reset: true })}>
            重试
          </button>
        </div>
      )}

      {loading && commits.length === 0 ? (
        <div className="git-loading">
          <RefreshCw size={18} className="spin" />
          <span>加载历史…</span>
        </div>
      ) : commits.length === 0 ? (
        <div className="git-history-empty">无提交记录</div>
      ) : (
        <ol className="git-timeline">
          {commits.map((commit) => {
            const filesState = filesByHash[commit.hash];
            const isExpanded = filesState && !filesState.collapsed;
            const shortHash = commit.hash.slice(0, 7);
            return (
              <li key={commit.hash} className="git-timeline-item">
                <div className="git-timeline-rail">
                  <span className="git-timeline-dot" aria-hidden="true" />
                </div>
                <div className="git-timeline-body">
                  <button
                    type="button"
                    className="git-timeline-commit"
                    onClick={() => toggleCommit(commit.hash)}
                    aria-expanded={isExpanded ? 'true' : 'false'}
                  >
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <GitCommit size={14} />
                    <span className="git-commit-subject" title={commit.subject}>{commit.subject || '(no subject)'}</span>
                    <span className="git-commit-meta">
                      <span className="git-commit-hash" title={commit.hash}>{shortHash}</span>
                      <span className="git-commit-author">{commit.author}</span>
                      <span className="git-commit-date">{formatDate(commit.date)}</span>
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="git-commit-files">
                      {filesState.loading ? (
                        <div className="git-loading small">
                          <RefreshCw size={14} className="spin" />
                          <span>加载文件…</span>
                        </div>
                      ) : filesState.error ? (
                        <div className="banner-error small">
                          <span>{filesState.error}</span>
                          <button
                            type="button"
                            className="ghost-btn small"
                            onClick={() => toggleCommit(commit.hash)}
                          >
                            重试
                          </button>
                        </div>
                      ) : filesState.files.length === 0 ? (
                        <div className="files-empty">无文件变化</div>
                      ) : (
                        <ul className="git-commit-file-list">
                          {filesState.files.map((file) => (
                            <li key={`${file.from || ''}|${file.path}`}>
                              <button
                                type="button"
                                className="file-row"
                                onClick={() => onSelectCommitFile?.(commit, file)}
                                title={file.from ? `${file.from} → ${file.path}` : file.path}
                              >
                                <FileDiff size={13} />
                                <span className={`status-badge status-${file.status?.[0] || 'X'}`}>
                                  {statusLabel(file.status)}
                                </span>
                                {file.from ? (
                                  <span className="git-file-rename">
                                    <span className="git-file-from">{file.from}</span>
                                    <span aria-hidden="true"> → </span>
                                    <span>{file.path}</span>
                                  </span>
                                ) : (
                                  <span>{file.path}</span>
                                )}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {hasMore && (
        <>
          <div ref={sentinelRef} className="git-load-sentinel" aria-hidden="true" />
          <div className="git-load-more">
            <button
              type="button"
              className="ghost-btn"
              onClick={() => loadPage()}
              disabled={loadingMore}
            >
              {loadingMore ? (
                <>
                  <RefreshCw size={14} className="spin" />
                  <span>加载中…</span>
                </>
              ) : (
                <span>加载更多</span>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default GitHistoryPanel;
