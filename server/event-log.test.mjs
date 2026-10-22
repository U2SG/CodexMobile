import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createEventLog, parseEventId } from './event-log.js';
import { createEventStreamHub } from './event-stream.js';

test('since() replays exactly the frames after the cursor', () => {
  const log = createEventLog({ epoch: 'e1' });
  const a = log.append({ type: 'status-update', n: 1 });
  log.append({ type: 'status-update', n: 2 });
  log.append({ type: 'chat-complete', n: 3 });
  const resume = log.since(a.id);
  assert.equal(resume.status, 'ok');
  assert.deepEqual(resume.events.map((e) => JSON.parse(e.data).n), [2, 3]);
  assert.deepEqual(log.since(log.lastId).events, []);
});

test('no cursor is fresh; a foreign epoch or a future seq is a gap', () => {
  const log = createEventLog({ epoch: 'e1' });
  log.append({ type: 'x' });
  assert.equal(log.since('').status, 'fresh');
  assert.equal(log.since('other:1').status, 'gap');
  assert.equal(log.since('e1:99').status, 'gap');
  assert.equal(log.since('garbage').status, 'gap');
  assert.deepEqual(parseEventId('e1:7'), { epoch: 'e1', seq: 7 });
});

test('only the newest assistant-update per message is kept, and it replays in its new position', () => {
  const log = createEventLog({ epoch: 'e1' });
  const start = log.append({ type: 'chat-started', turnId: 't' });
  log.append({ type: 'assistant-update', turnId: 't', messageId: 'm', content: 'He' });
  log.append({ type: 'activity-update', turnId: 't', messageId: 'tool' });
  log.append({ type: 'assistant-update', turnId: 't', messageId: 'm', content: 'Hello' });
  const replay = log.since(start.id).events.map((e) => JSON.parse(e.data));
  assert.deepEqual(replay.map((p) => p.type), ['activity-update', 'assistant-update']);
  assert.equal(replay[1].content, 'Hello');
});

test('a cursor older than the rolled-off head is a gap', () => {
  const log = createEventLog({ epoch: 'e1', maxEvents: 3 });
  const first = log.append({ type: 'x', n: 1 });
  for (let n = 2; n <= 5; n += 1) log.append({ type: 'x', n });
  assert.equal(log.since(first.id).status, 'gap');
  const recent = log.since('e1:3');
  assert.equal(recent.status, 'ok');
  assert.deepEqual(recent.events.map((e) => JSON.parse(e.data).n), [4, 5]);
});

test('the byte budget evicts the oldest frames', () => {
  const log = createEventLog({ epoch: 'e1', maxBytes: 200 });
  const first = log.append({ type: 'x', pad: 'a'.repeat(120) });
  const second = log.append({ type: 'x', pad: 'b'.repeat(120) });
  log.append({ type: 'x', pad: 'c'.repeat(120) });
  // Frame 2 was evicted, so a client that stopped at frame 1 missed it.
  assert.equal(log.since(first.id).status, 'gap');
  assert.equal(log.since(second.id).status, 'ok');
});

async function withHub(fn) {
  const log = createEventLog({ epoch: 'e1' });
  const hub = createEventStreamHub({ log, helloFrames: async () => [{ type: 'connected' }] });
  const server = http.createServer((req, res) => hub.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn({ hub, log, url: `http://127.0.0.1:${port}/api/events` });
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

async function readFrames(url, headers, count) {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const fields = Object.fromEntries(block.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
      frames.push(fields);
    }
  }
  controller.abort();
  return frames;
}

test('a reconnect with Last-Event-ID gets resume:ok, the missed frames, hello, then live frames', async () => {
  await withHub(async ({ hub, log, url }) => {
    const seen = log.append({ type: 'status-update', n: 1 });
    hub.publish({ type: 'status-update', n: 2 });
    const pending = readFrames(url, { 'last-event-id': seen.id }, 4);
    await new Promise((resolve) => setTimeout(resolve, 50));
    hub.publish({ type: 'chat-complete', n: 3 });
    const frames = await pending;
    assert.equal(frames[0].event, 'resume');
    assert.equal(JSON.parse(frames[0].data).status, 'ok');
    assert.equal(JSON.parse(frames[1].data).n, 2);
    assert.equal(frames[1].id, 'e1:2');
    assert.equal(JSON.parse(frames[2].data).type, 'connected');
    assert.equal(frames[2].id, undefined);
    assert.equal(JSON.parse(frames[3].data).n, 3);
  });
});

test('a stale cursor gets resume:gap', async () => {
  await withHub(async ({ url }) => {
    const frames = await readFrames(url, { 'last-event-id': 'old-epoch:5' }, 1);
    assert.equal(JSON.parse(frames[0].data).status, 'gap');
  });
});
