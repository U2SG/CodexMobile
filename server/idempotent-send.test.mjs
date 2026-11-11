import assert from 'node:assert/strict';
import test from 'node:test';

import { createIdempotentRunner } from './idempotent-send.js';

test('a repeated key reuses the first result instead of running again', async () => {
  const run = createIdempotentRunner();
  let calls = 0;
  const task = async () => ({ turnId: `t${++calls}` });
  const first = await run('client-1', task);
  const second = await run('client-1', task);
  assert.equal(calls, 1);
  assert.deepEqual(first, { turnId: 't1' });
  assert.deepEqual(second, { turnId: 't1', duplicate: true });
});

test('a retry arriving while the first request runs waits for it', async () => {
  const run = createIdempotentRunner();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const task = async () => { calls += 1; await gate; return { turnId: 'only' }; };
  const pending = [run('k', task), run('k', task)];
  release();
  const results = await Promise.all(pending);
  assert.equal(calls, 1);
  assert.equal(results[1].turnId, 'only');
});

test('a failed attempt is forgotten so the retry runs', async () => {
  const run = createIdempotentRunner();
  await assert.rejects(run('k', async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(await run('k', async () => ({ ok: true })), { ok: true });
});

test('entries expire after the ttl and requests without a key always run', async () => {
  let clock = 0;
  const run = createIdempotentRunner({ ttlMs: 1000, now: () => clock });
  let calls = 0;
  const task = async () => ({ n: ++calls });
  await run('k', task);
  clock = 5000;
  assert.deepEqual(await run('k', task), { n: 2 });
  await run('', task);
  await run(null, task);
  assert.equal(calls, 4);
});
