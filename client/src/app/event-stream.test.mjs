import assert from 'node:assert/strict';
import test from 'node:test';
import { CONNECT_TIMEOUT_MS, FOREGROUND_STALE_MS, STREAM_STALE_MS, createEventStream, parseSseChunk } from './event-stream.js';

test('parseSseChunk yields complete frames and keeps the partial tail', () => {
  const frames = [];
  const rest = parseSseChunk('event: resume\ndata: {"status":"ok"}\n\nid: e:1\ndata: {"a":1}\n\nid: e:2\ndata: {"a"', (f) => frames.push(f));
  assert.deepEqual(frames, [
    { id: null, event: 'resume', data: '{"status":"ok"}' },
    { id: 'e:1', event: 'message', data: '{"a":1}' }
  ]);
  assert.equal(rest, 'id: e:2\ndata: {"a"');
  const more = [];
  assert.equal(parseSseChunk(`${rest}:2}\n\n`, (f) => more.push(f)), '');
  assert.deepEqual(more, [{ id: 'e:2', event: 'message', data: '{"a":2}' }]);
});

// A controllable world: fake clock + timers + a fetch whose streams we feed.
function harness() {
  let clock = 1_000;
  const timers = new Map();
  let nextTimer = 1;
  const streams = [];
  const fetchImpl = async (url, init) => {
    let controller;
    const body = new ReadableStream({ start(c) { controller = c; } });
    const entry = { url, init, push: (text) => controller.enqueue(new TextEncoder().encode(text)), end: () => controller.close() };
    init.signal.addEventListener('abort', () => {
      try { controller.error(new Error('aborted')); } catch { /* closed */ }
    });
    streams.push(entry);
    return { ok: true, status: 200, body };
  };
  const api = {
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock + ms, interval: 0 }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock + ms, interval: ms }); return id; },
    clearInterval: (id) => timers.delete(id)
  };
  async function advance(ms) {
    const until = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, t] = due;
      clock = t.at;
      if (t.interval) t.at += t.interval; else timers.delete(id);
      t.fn();
      await flush();
    }
    clock = until;
  }
  return { fetchImpl, timers: api, now: () => clock, streams, advance };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

function open(world, extra = {}) {
  const payloads = [];
  const resumes = [];
  const states = [];
  const stream = createEventStream({
    getToken: () => 'tok',
    onPayload: (p) => payloads.push(p),
    onResume: (s) => resumes.push(s),
    onStateChange: (s) => states.push(s),
    fetchImpl: world.fetchImpl,
    now: world.now,
    timers: world.timers,
    isHidden: () => false,
    ...extra
  });
  return { stream, payloads, resumes, states };
}

test('reconnect sends the last handled id as Last-Event-ID and the bearer token', async () => {
  const world = harness();
  const { stream, payloads, resumes } = open(world);
  stream.start();
  await flush();
  assert.equal(world.streams[0].init.headers.authorization, 'Bearer tok');
  assert.equal(world.streams[0].init.headers['last-event-id'], undefined);
  world.streams[0].push('event: resume\ndata: {"status":"fresh"}\n\nid: ep:1\ndata: {"type":"a"}\n\ndata: {"type":"connected"}\n\n');
  await flush();
  assert.deepEqual(resumes, ['fresh']);
  assert.deepEqual(payloads.map((p) => p.type), ['a', 'connected']);
  assert.equal(stream.lastEventId, 'ep:1');

  world.streams[0].end();
  await flush();
  await world.advance(2_000);
  assert.equal(world.streams.length, 2);
  assert.equal(world.streams[1].init.headers['last-event-id'], 'ep:1');
  stream.stop();
});

test('a connect that never produces its resume frame is retried', async () => {
  const world = harness();
  const { stream, states } = open(world);
  stream.start();
  await flush();
  await world.advance(CONNECT_TIMEOUT_MS + 2_000);
  assert.ok(world.streams.length >= 2);
  assert.ok(states.includes('disconnected'));
  stream.stop();
});

test('a silent stream is replaced after the stale window; foreground replaces it sooner', async () => {
  const world = harness();
  const { stream } = open(world);
  stream.start();
  await flush();
  world.streams[0].push('event: resume\ndata: {"status":"fresh"}\n\n');
  await flush();

  // Foreground after a short silence keeps the stream.
  await world.advance(FOREGROUND_STALE_MS - 5_000);
  stream.onForeground();
  await flush();
  assert.equal(world.streams.length, 1);

  // Foreground after a long silence replaces it immediately.
  await world.advance(10_000);
  stream.onForeground();
  await flush();
  assert.equal(world.streams.length, 2);
  world.streams[1].push('event: resume\ndata: {"status":"ok"}\n\n');
  await flush();

  // With no foreground event, the watchdog catches a dead stream.
  await world.advance(STREAM_STALE_MS + 16_000);
  assert.ok(world.streams.length >= 3);
  stream.stop();
});

test('a 401 is reported with the rejected token', async () => {
  const world = harness();
  const rejected = [];
  const { stream } = open(world, {
    fetchImpl: async () => ({ ok: false, status: 401, body: null }),
    onAuthRejected: (token) => rejected.push(token)
  });
  stream.start();
  await flush();
  assert.deepEqual(rejected, ['tok']);
  stream.stop();
});

test('reconnects pause while hidden and resume on foreground', async () => {
  const world = harness();
  let hidden = false;
  const { stream } = open(world, { isHidden: () => hidden });
  stream.start();
  await flush();
  hidden = true;
  world.streams[0].end();
  await flush();
  await world.advance(60_000);
  assert.equal(world.streams.length, 1);
  hidden = false;
  stream.onForeground();
  await flush();
  assert.equal(world.streams.length, 2);
  stream.stop();
});

test('a fresh or gap resume adopts the server cursor for the next reconnect', async () => {
  const world = harness();
  const { stream } = open(world);
  stream.start();
  await flush();
  world.streams[0].push('event: resume\ndata: {"status":"fresh","cursor":"ep:7"}\n\n');
  await flush();
  assert.equal(stream.lastEventId, 'ep:7');
  world.streams[0].end();
  await flush();
  await world.advance(2_000);
  assert.equal(world.streams[1].init.headers['last-event-id'], 'ep:7');
  stream.stop();
});
