// Server-side event log for the SSE stream (/api/events). Every broadcast is
// appended with an id `${epoch}:${seq}`; a reconnecting client sends the last
// id it handled and gets exactly the frames it missed, in order — or `gap`,
// meaning the log no longer covers that point (server restarted: new epoch;
// or the ring buffer rolled past it) and the client must refetch state.
//
// assistant-update frames carry the whole reply so far, so only the newest
// one per message is kept: a long streamed reply cannot flush everything
// else out of the buffer, and replaying the newest frame is equivalent to
// replaying all of them.

import crypto from 'node:crypto';

const DEFAULT_MAX_EVENTS = 256;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function supersedeKey(payload) {
  if (payload?.type !== 'assistant-update') return null;
  return `${payload.turnId || ''}:${payload.messageId || ''}`;
}

export function parseEventId(value) {
  const match = /^([A-Za-z0-9_-]+):(\d+)$/.exec(String(value || '').trim());
  return match ? { epoch: match[1], seq: Number(match[2]) } : null;
}

export function createEventLog({
  maxEvents = DEFAULT_MAX_EVENTS,
  maxBytes = DEFAULT_MAX_BYTES,
  epoch = crypto.randomBytes(6).toString('base64url')
} = {}) {
  let seq = 0;
  let bytes = 0;
  // Ordered by seq; superseded entries are removed, so seqs may skip.
  const entries = [];
  // Highest seq that has been dropped from the head. A client whose cursor
  // is below this has missed frames the log no longer has.
  let droppedThrough = 0;

  function dropHead() {
    const removed = entries.shift();
    bytes -= removed.data.length;
    droppedThrough = Math.max(droppedThrough, removed.seq);
  }

  function append(payload) {
    seq += 1;
    const id = `${epoch}:${seq}`;
    const data = JSON.stringify(payload);
    const key = supersedeKey(payload);
    if (key) {
      const index = entries.findIndex((entry) => entry.key === key);
      if (index >= 0) {
        bytes -= entries[index].data.length;
        entries.splice(index, 1);
      }
    }
    entries.push({ seq, id, data, key });
    bytes += data.length;
    while (entries.length > maxEvents || (bytes > maxBytes && entries.length > 1)) {
      dropHead();
    }
    return { id, data };
  }

  // Frames after `lastEventId`, or gap. No cursor means a fresh client: it
  // loads state over HTTP and only needs live frames from here.
  function since(lastEventId) {
    if (!lastEventId) return { status: 'fresh', events: [] };
    const cursor = parseEventId(lastEventId);
    if (!cursor || cursor.epoch !== epoch || cursor.seq > seq) return { status: 'gap', events: [] };
    if (cursor.seq < droppedThrough) return { status: 'gap', events: [] };
    return { status: 'ok', events: entries.filter((entry) => entry.seq > cursor.seq) };
  }

  return {
    append,
    since,
    get epoch() { return epoch; },
    get lastId() { return seq ? `${epoch}:${seq}` : null; },
    // Position a client is at once it has seen everything so far; valid even
    // before the first frame (`epoch:0`), so a quiet connect still resumes.
    get cursor() { return `${epoch}:${seq}`; }
  };
}
