import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createBridgeStatusCache } from './desktop-bridge.js';

function makeClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

function makeProbe(responses) {
  const queue = [...responses];
  const probe = async () => {
    probe.calls += 1;
    if (queue.length > 1) return queue.shift();
    return queue[0];
  };
  probe.calls = 0;
  return probe;
}

test('first call probes and caches result', async () => {
  const clock = makeClock();
  const probe = makeProbe([{ connected: true, mode: 'desktop-ipc', reason: null }]);
  const cache = createBridgeStatusCache({ probe, clock: clock.now, ttlMs: 2500 });
  const status = await cache.getStatus();
  assert.equal(status.connected, true);
  assert.equal(probe.calls, 1);
  assert.ok(typeof status.checkedAt === 'number');
});

test('subsequent calls within ttl reuse cached value', async () => {
  const clock = makeClock();
  const probe = makeProbe([{ connected: true, mode: 'desktop-ipc', reason: null }]);
  const cache = createBridgeStatusCache({ probe, clock: clock.now, ttlMs: 2500 });
  await cache.getStatus();
  clock.advance(2000);
  await cache.getStatus();
  await cache.getStatus();
  assert.equal(probe.calls, 1);
});

test('refreshes after ttl expires', async () => {
  const clock = makeClock();
  const probe = makeProbe([
    { connected: true, mode: 'desktop-ipc', reason: null },
    { connected: false, mode: 'desktop-ipc', reason: 'gone' }
  ]);
  const cache = createBridgeStatusCache({ probe, clock: clock.now, ttlMs: 2500 });
  const a = await cache.getStatus();
  assert.equal(a.connected, true);
  clock.advance(2600);
  const b = await cache.getStatus();
  assert.equal(b.connected, false);
  assert.equal(probe.calls, 2);
});

test('force=true bypasses cache', async () => {
  const clock = makeClock();
  const probe = makeProbe([
    { connected: true, mode: 'desktop-ipc', reason: null },
    { connected: false, mode: 'desktop-ipc', reason: 'down' }
  ]);
  const cache = createBridgeStatusCache({ probe, clock: clock.now, ttlMs: 60000 });
  const a = await cache.getStatus();
  const b = await cache.getStatus({ force: true });
  assert.equal(a.connected, true);
  assert.equal(b.connected, false);
  assert.equal(probe.calls, 2);
});

test('concurrent getStatus calls share a single in-flight probe', async () => {
  const clock = makeClock();
  let resolveProbe;
  const probe = Object.assign(
    () => new Promise((resolve) => { resolveProbe = resolve; }),
    { calls: 0 }
  );
  const wrapped = async () => { probe.calls += 1; return probe(); };
  const cache = createBridgeStatusCache({ probe: wrapped, clock: clock.now, ttlMs: 2500 });
  const p1 = cache.getStatus();
  const p2 = cache.getStatus();
  const p3 = cache.getStatus();
  resolveProbe({ connected: true, mode: 'desktop-ipc', reason: null });
  const [a, b, c] = await Promise.all([p1, p2, p3]);
  assert.equal(a.connected, true);
  assert.equal(b.connected, true);
  assert.equal(c.connected, true);
  assert.equal(probe.calls, 1, 'should de-dupe in-flight probes');
});

test('probe failure caches as disconnected', async () => {
  const clock = makeClock();
  const probe = async () => { throw new Error('boom'); };
  const cache = createBridgeStatusCache({ probe, clock: clock.now, ttlMs: 2500 });
  const status = await cache.getStatus();
  assert.equal(status.connected, false);
  assert.match(status.reason, /boom/);
});

test('getCachedStatus returns last value without probing', async () => {
  const clock = makeClock();
  const probe = makeProbe([{ connected: true, mode: 'desktop-ipc', reason: null }]);
  const cache = createBridgeStatusCache({ probe, clock: clock.now, ttlMs: 2500 });
  assert.equal(cache.getCachedStatus(), null);
  await cache.getStatus();
  const cached = cache.getCachedStatus();
  assert.equal(cached.connected, true);
  assert.equal(probe.calls, 1);
});

test('onChange fires when connected flips, not on every refresh', async () => {
  const clock = makeClock();
  const probe = makeProbe([
    { connected: true, mode: 'desktop-ipc', reason: null },
    { connected: true, mode: 'desktop-ipc', reason: null },
    { connected: false, mode: 'desktop-ipc', reason: 'gone' }
  ]);
  const cache = createBridgeStatusCache({ probe, clock: clock.now, ttlMs: 100 });
  const events = [];
  cache.onChange((status) => events.push(status.connected));
  await cache.getStatus();
  clock.advance(200);
  await cache.getStatus();
  clock.advance(200);
  await cache.getStatus();
  assert.deepEqual(events, [true, false], 'should fire on first probe and on connected flip, not on identical refresh');
});

test('onChange unsubscribe stops further events', async () => {
  const clock = makeClock();
  const probe = makeProbe([
    { connected: true, mode: 'desktop-ipc', reason: null },
    { connected: false, mode: 'desktop-ipc', reason: 'gone' }
  ]);
  const cache = createBridgeStatusCache({ probe, clock: clock.now, ttlMs: 100 });
  const events = [];
  const off = cache.onChange((status) => events.push(status.connected));
  await cache.getStatus();
  off();
  clock.advance(200);
  await cache.getStatus();
  assert.deepEqual(events, [true]);
});

test('default ttlMs is 2500', async () => {
  const clock = makeClock();
  const probe = makeProbe([{ connected: true, mode: 'desktop-ipc', reason: null }]);
  const cache = createBridgeStatusCache({ probe, clock: clock.now });
  await cache.getStatus();
  clock.advance(2400);
  await cache.getStatus();
  assert.equal(probe.calls, 1);
  clock.advance(200);
  await cache.getStatus();
  assert.equal(probe.calls, 2);
});
