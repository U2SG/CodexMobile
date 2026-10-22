// GET /api/events — the PWA's live channel (Server-Sent Events).
//
// Each connection opens with a `resume` frame telling the client whether its
// Last-Event-ID could be honoured, plus `cursor`, the log position it is now
// at (adopt it so a later reconnect resumes from here even if no logged frame
// arrives first):
//   ok    — the frames it missed follow, in order, then live frames;
//   gap   — the log no longer covers its cursor; refetch state over HTTP;
//   fresh — no cursor; it just loaded state, live frames follow.
// Logged frames carry `id:`; the client advances its cursor only after
// handling one, so delivery is at-least-once and handlers must stay
// idempotent (they upsert by id). Per-connection frames without an id
// (current status, pending approvals) follow asynchronously: they may be slow
// to compute and must not hold up the resume the client is waiting for.
//
// A connection that stops draining is cut rather than buffered without bound:
// the client reconnects with its cursor and the log replays what it missed.

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

function frame({ id = null, event = null, data }) {
  let out = '';
  if (event) out += `event: ${event}\n`;
  if (id) out += `id: ${id}\n`;
  return `${out}data: ${data}\n\n`;
}

export function createEventStreamHub({ log, helloFrames = async () => [] }) {
  const clients = new Set();

  function write(res, text) {
    if (res.destroyed || res.writableEnded) {
      clients.delete(res);
      return false;
    }
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      clients.delete(res);
      res.destroy();
      return false;
    }
    res.write(text);
    return true;
  }

  async function handle(req, res) {
    const drop = () => clients.delete(res);
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
    req.socket.setNoDelay?.(true);
    req.socket.setKeepAlive?.(true, 20_000);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Proxies (nginx-style) must not buffer the stream.
      'x-accel-buffering': 'no'
    });
    const url = new URL(req.url || '/', 'http://localhost');
    const lastEventId = req.headers['last-event-id'] || url.searchParams.get('lastEventId') || '';
    // Synchronous from here to clients.add: no publish can land between the
    // replay and live delivery (a frame is either replayed or live, never
    // neither).
    const resume = log.since(lastEventId);
    const opened = write(res, frame({
      event: 'resume',
      data: JSON.stringify({ status: resume.status, epoch: log.epoch, cursor: log.cursor })
    }));
    if (!opened) return;
    for (const entry of resume.events) {
      write(res, frame({ id: entry.id, data: entry.data }));
    }
    clients.add(res);

    let hello = [];
    try {
      hello = await helloFrames();
    } catch (error) {
      console.warn('[events] hello frames failed:', error?.message || error);
    }
    for (const payload of hello) {
      write(res, frame({ data: JSON.stringify(payload) }));
    }
  }

  // Logged: replayable after a reconnect.
  function publish(payload) {
    const { id, data } = log.append(payload);
    const text = frame({ id, data });
    for (const res of clients) write(res, text);
  }

  // Not logged: heartbeats, and frames whose replay would be wrong (an
  // approval resolved meanwhile; reconnects get the live list in hello).
  function send(payload) {
    const text = frame({ data: JSON.stringify(payload) });
    for (const res of clients) write(res, text);
  }

  return { handle, publish, send, get size() { return clients.size; } };
}
