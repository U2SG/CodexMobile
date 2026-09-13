// zh-CN date/time formatters used across session lists and chat messages.

export function formatDuration(start, end = Date.now()) {
  const startMs = new Date(start || end).getTime();
  const endMs = new Date(end || Date.now()).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return '';
  }
  const totalSeconds = Math.max(1, Math.round((endMs - startMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

export function formatDurationMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) {
    return '';
  }
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

export function formatTime(value) {
  if (!value) {
    return '';
  }
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));
  } catch {
    return '';
  }
}
