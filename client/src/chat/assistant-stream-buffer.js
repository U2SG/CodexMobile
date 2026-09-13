// Throttle buffer for streaming assistant-update payloads. Coalesces partial
// updates by (turnId, messageId) so cumulative content payloads collapse to
// one apply per ~60ms; done=true payloads flush synchronously and drain any
// other pending entries so they don't lag behind a finished message.

export function createAssistantStreamBuffer({ flushIntervalMs = 60 } = {}) {
  const pending = new Map();
  let timerId = null;

  function clearTimer() {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  function flushAll() {
    clearTimer();
    if (pending.size === 0) return;
    const entries = Array.from(pending.values());
    pending.clear();
    for (const { payload, apply } of entries) {
      apply(payload);
    }
  }

  function bufferKey(payload) {
    return `${payload?.turnId || ''}:${payload?.messageId || ''}`;
  }

  function schedule(payload, apply) {
    const key = bufferKey(payload);
    if (payload?.done) {
      pending.delete(key);
      apply(payload);
      flushAll();
      return;
    }
    pending.set(key, { payload, apply });
    if (timerId === null) {
      timerId = setTimeout(flushAll, flushIntervalMs);
    }
  }

  return { schedule, flushAll };
}
