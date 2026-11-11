export const RUN_STATUS_LABEL = {
  approval: '等待审批',
  running: '运行中',
  queued: '排队'
};

export function formatElapsed(startedAt, now = Date.now()) {
  const started = Date.parse(startedAt || '');
  if (!Number.isFinite(started)) return '';
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ''}`;
}

export function runStatusText(run, now = Date.now()) {
  if (run.status === 'queued') return `排队 ${run.queued} 条`;
  if (run.status === 'running') {
    const elapsed = formatElapsed(run.startedAt, now);
    return elapsed ? `运行中 ${elapsed}` : '运行中';
  }
  return RUN_STATUS_LABEL[run.status] || run.status;
}

export function runContextLine(run) {
  return [run.projectName, run.worktree, run.branch].filter(Boolean).join(' · ');
}
