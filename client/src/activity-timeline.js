// Filter for the activity timeline rendering layer.
//
// Hides placeholder tool entries that arrived without any concrete payload
// (no detail / command / output / error / subAgents) and whose label is one
// of the canonical generic strings emitted while a tool call is still
// settling. Once the underlying call lands real content, isPlaceholder…
// returns false and the entry stays.
//
// Not yet wired into App.jsx — local activity rendering keeps placeholder
// rows visible. Wire-up lands when ActivityTimeline.jsx ports over (Batch B).

export function isPlaceholderTimelineItem(item = null) {
  if (!item || item.type !== 'tool') {
    return false;
  }
  const label = String(item.label || '').replace(/\s+/g, ' ').trim();
  const hasDetail = Boolean(
    String(item.detail || '').trim() ||
    String(item.command || '').trim() ||
    String(item.output || '').trim() ||
    String(item.error || '').trim() ||
    (Array.isArray(item.subAgents) && item.subAgents.length)
  );
  if (hasDetail) {
    return false;
  }
  return /^(正在完成一步操作|已完成一步操作|这一步操作失败|调用工具)$/.test(label);
}
