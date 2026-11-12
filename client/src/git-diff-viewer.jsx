import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, MessageSquare, X } from 'lucide-react';

import { apiFetch } from './api.js';
import { annotateDiffLines, describeDiffRange } from './git-diff-lines.js';

function splitPath(filePath) {
  if (!filePath) return [];
  // Normalize Windows separators so the breadcrumb shows the same shape
  // on both hosts.
  return String(filePath).replace(/\\/g, '/').split('/').filter(Boolean);
}

function findLineIndex(node, bodyRef) {
  // Walk up from anchorNode / focusNode until we hit a span carrying
  // data-line-index. Returns -1 if the node is outside the diff body.
  if (!node || !bodyRef.current) return -1;
  let cursor = node.nodeType === 1 ? node : node.parentElement;
  while (cursor && cursor !== bodyRef.current) {
    if (cursor.dataset?.lineIndex != null) {
      const n = Number(cursor.dataset.lineIndex);
      return Number.isFinite(n) ? n : -1;
    }
    cursor = cursor.parentElement;
  }
  return -1;
}

export function GitDiffViewer({
  diff,
  file,
  commit,
  staged,
  projectId,
  // Optional peer registry for deep-linking foreign-agent badges to the
  // sibling CodexMobile server. Pass null/empty → foreign badges become
  // disabled with a hint.
  peers = [],
  // Current server's agent ('codex' | 'claude'). Used to decide which
  // related-sessions badges are local-clickable vs deep-link.
  currentAgent = null,
  onPathClick,
  onSelectionChange,
  onSelectSession,
  // Saved review comments for this file/commit: [{ id, endIndex, body }].
  comments = [],
  onDeleteComment,
  // Bumped by the parent to drop the current selection (e.g. after saving
  // a comment on it).
  selectionResetKey = 0
}) {
  const bodyRef = useRef(null);
  const [selection, setSelection] = useState(null);
  const [relatedSessions, setRelatedSessions] = useState([]);
  const segments = useMemo(() => splitPath(file), [file]);
  const lines = useMemo(() => (diff || '').split('\n'), [diff]);
  const annotated = useMemo(() => annotateDiffLines(lines), [lines]);
  // Tap-to-select: a phone cannot drag a precise text selection inside a
  // <pre>, so tapping one row selects it and tapping a second extends.
  const [tapRange, setTapRange] = useState(null); // { start, end } diff row indices
  const tapRangeRef = useRef(null);
  tapRangeRef.current = tapRange;
  const selectionRef = useRef(null);
  selectionRef.current = selection;

  const reportRange = useCallback((start, end, text) => {
    const startIndex = Math.min(start, end);
    const endIndex = Math.max(start, end);
    const next = {
      file,
      commit,
      startIndex,
      endIndex,
      rangeLabel: describeDiffRange(annotated, startIndex, endIndex),
      text: text ?? lines.slice(startIndex, endIndex + 1).join('\n')
    };
    setSelection(next);
    onSelectionChange?.(next);
  }, [annotated, commit, file, lines, onSelectionChange]);

  const clearSelection = useCallback(() => {
    setTapRange(null);
    setSelection(null);
    onSelectionChange?.(null);
  }, [onSelectionChange]);

  useEffect(() => {
    setTapRange(null);
    setSelection(null);
  }, [selectionResetKey, file, commit]);

  const handleLineTap = useCallback((index) => {
    const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
    if (sel && !sel.isCollapsed) return; // a text selection is in progress
    const current = tapRangeRef.current;
    if (current && current.start === current.end && current.start === index) {
      clearSelection();
      return;
    }
    const next = current && current.start === current.end
      ? { start: Math.min(current.start, index), end: Math.max(current.start, index) }
      : { start: index, end: index };
    setTapRange(next);
    reportRange(next.start, next.end);
  }, [clearSelection, reportRange]);

  // Fetch "recent sessions that touched this file" so we can render
  // attribution badges in the breadcrumb row. apply_patch-only signal —
  // shell-based writes are intentionally not in the index (see
  // server/file-session-index.js header). projectId + file together form
  // the lookup key; bail when either is missing.
  useEffect(() => {
    if (!projectId || !file) {
      setRelatedSessions([]);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ projectId, path: file, limit: '3' });
    apiFetch(`/api/files/sessions?${params.toString()}`)
      .then((data) => {
        if (cancelled) return;
        setRelatedSessions(Array.isArray(data?.sessions) ? data.sessions : []);
      })
      .catch(() => {
        if (!cancelled) setRelatedSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, file]);

  // Watch for user text selection inside the diff body and report it as a
  // diff row range. Runs on every selectionchange but bails fast when the
  // selection is empty or outside our body. A collapsed selection only
  // clears when no tapped range is active (a tap collapses the selection).
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const handler = () => {
      const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
      const body = bodyRef.current;
      const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
      const inside = range && body && body.contains(range.startContainer) && body.contains(range.endContainer);
      const startIdx = inside ? findLineIndex(range.startContainer, bodyRef) : -1;
      const endIdx = inside ? findLineIndex(range.endContainer, bodyRef) : -1;
      if (startIdx < 0 || endIdx < 0) {
        if (!tapRangeRef.current && selectionRef.current) {
          setSelection(null);
          onSelectionChange?.(null);
        }
        return;
      }
      setTapRange(null);
      reportRange(startIdx, endIdx, sel.toString());
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [onSelectionChange, reportRange]);

  const handleSegmentClick = useCallback(
    (idx) => {
      if (!onPathClick) return;
      const partial = segments.slice(0, idx + 1).join('/');
      onPathClick(partial);
    },
    [segments, onPathClick]
  );

  return (
    <div className="git-diff-viewer">
      <div className="git-diff-breadcrumb" aria-label="文件路径">
        {segments.length === 0 ? (
          <span className="git-diff-breadcrumb-empty">无文件</span>
        ) : (
          segments.map((segment, idx) => {
            const isLast = idx === segments.length - 1;
            return (
              <span key={`${idx}-${segment}`} className="git-diff-breadcrumb-row">
                {idx > 0 && <ChevronRight size={12} aria-hidden="true" />}
                <button
                  type="button"
                  className={`git-diff-breadcrumb-segment ${isLast ? 'is-last' : ''}`}
                  onClick={() => handleSegmentClick(idx)}
                  disabled={!onPathClick}
                  title={segments.slice(0, idx + 1).join('/')}
                >
                  {segment}
                </button>
              </span>
            );
          })
        )}
        <span className="git-diff-breadcrumb-tags">
          {staged ? <em className="staged-tag">已暂存</em> : null}
          {commit ? (
            <em className="staged-tag" title={commit}>@ {String(commit).slice(0, 7)}</em>
          ) : null}
        </span>
      </div>

      {relatedSessions.length > 0 && (
        <div className="git-diff-related-sessions" aria-label="编辑过此文件的近期对话">
          <MessageSquare size={12} aria-hidden="true" />
          <span className="git-diff-related-label">近期改过：</span>
          {relatedSessions.map((session) => {
            const isForeign = Boolean(
              session.agent && currentAgent && session.agent !== currentAgent
            );
            const peerForAgent = isForeign
              ? (Array.isArray(peers) ? peers.find((p) => p.agent === session.agent) : null)
              : null;
            const baseTitle = `session ${session.sessionId}${session.cwd ? ` · ${session.cwd}` : ''}${session.touchedAt ? ` · ${new Date(session.touchedAt).toLocaleString()}` : ''}`;
            const inner = (
              <>
                {session.agent ? (
                  <span className={`git-diff-related-agent is-${session.agent}`}>
                    {session.agent === 'claude' ? 'Claude' : 'Codex'}
                  </span>
                ) : null}
                <span className="git-diff-related-hash">{session.sessionId.slice(0, 8)}</span>
                {session.op ? <span className="git-diff-related-op">{session.op}</span> : null}
              </>
            );
            if (isForeign && peerForAgent) {
              const peerUrl = `${peerForAgent.url.replace(/\/$/, '')}/?session=${encodeURIComponent(session.sessionId)}`;
              return (
                <a
                  key={session.sessionId}
                  href={peerUrl}
                  className="git-diff-related-badge is-peer-link"
                  title={`${baseTitle} · 在 ${peerForAgent.label} 服务器打开`}
                >
                  {inner}
                </a>
              );
            }
            if (isForeign) {
              return (
                <button
                  key={session.sessionId}
                  type="button"
                  className="git-diff-related-badge is-foreign-disabled"
                  disabled
                  title={`${baseTitle} · 这是 ${session.agent} 对话，需要在该 agent 的服务器恢复。配置 CODEXMOBILE_PEER_URLS 后可直接跳转。`}
                >
                  {inner}
                </button>
              );
            }
            return (
              <button
                key={session.sessionId}
                type="button"
                className="git-diff-related-badge"
                onClick={() => onSelectSession?.(session)}
                disabled={!onSelectSession}
                title={baseTitle}
              >
                {inner}
              </button>
            );
          })}
        </div>
      )}

      <pre ref={bodyRef} className="git-diff-body diff-view" data-selection-host>
        {lines.map((line, idx) => {
          const selected = selection && idx >= selection.startIndex && idx <= selection.endIndex;
          const lineComments = comments.filter((comment) => comment.endIndex === idx);
          return (
            <span key={idx}>
              <span
                data-line-index={idx}
                className={`diff-line ${annotated[idx]?.kind || 'ctx'}${selected ? ' is-selected' : ''}`}
                onClick={() => handleLineTap(idx)}
              >
                {line || ' '}
                {'\n'}
              </span>
              {lineComments.map((comment) => (
                <span key={comment.id} className="diff-comment" data-comment-id={comment.id}>
                  <MessageSquare size={12} aria-hidden="true" />
                  <span className="diff-comment-body">{comment.body}</span>
                  {onDeleteComment ? (
                    <button type="button" className="diff-comment-delete" onClick={() => onDeleteComment(comment.id)} aria-label="删除批注">
                      <X size={12} />
                    </button>
                  ) : null}
                  {'\n'}
                </span>
              ))}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

export default GitDiffViewer;
