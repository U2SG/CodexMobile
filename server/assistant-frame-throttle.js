// assistant-update frames carry the whole reply so far and arrive once per
// token, so sending each one costs bandwidth quadratic in reply length and a
// phone re-render per token. Hold the newest snapshot per message and send it
// on a short timer; every other frame (done snapshots included) first flushes
// what is held so ordering is unchanged.
export function createAssistantFrameThrottle({ deliver, intervalMs = 80 }) {
  const held = new Map();
  let timer = null;

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!held.size) return;
    const frames = [...held.values()];
    held.clear();
    for (const frame of frames) deliver(frame);
  }

  function send(payload) {
    if (payload?.type === 'assistant-update' && !payload.done) {
      held.set(`${payload.turnId || ''}:${payload.messageId || ''}`, payload);
      timer ||= setTimeout(flush, intervalMs);
      return;
    }
    flush();
    deliver(payload);
  }

  return { send, flush };
}
