// Helpers for the activity-timeline rendering layer.
//
// `isThinkingActivityStep` recognises a still-live reasoning step so the
// timeline can keep "正在思考" as a visible entry until the reasoning turns
// over. `thinkingActivityText` picks the user-facing label for that entry,
// falling back to the canonical mobile string when the upstream payload
// doesn't ship one.
//
// Not yet wired into App.jsx — local `isVisibleActivityStep` filters
// generic-thinking labels OUT, which is the inverse intent. Both can
// coexist; the wire-up lands when ActivityTimeline.jsx ports over (Batch B).

export function isThinkingActivityStep(step = null) {
  const kind = String(step?.kind || '');
  const label = String(step?.label || step?.content || '').trim();
  if (kind !== 'reasoning') {
    return false;
  }
  const status = String(step?.status || '').toLowerCase();
  if (['completed', 'failed', 'cancelled', 'canceled'].includes(status)) {
    return false;
  }
  return /正在思考|思考中|thinking/i.test(label) || status === 'running' || status === 'queued';
}

export function thinkingActivityText(step = null) {
  const label = String(step?.label || step?.content || '').trim();
  return label || '正在思考';
}
