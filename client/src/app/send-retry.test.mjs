import assert from 'node:assert/strict';
import test from 'node:test';

import { isRetriableSendError, sendWithRetry, waitForRetry } from './send-retry.js';

const networkError = () => Object.assign(new TypeError('Failed to fetch'), { network: true });
const noWait = async () => {};

test('classifies network and gateway failures as retriable, business errors as final', () => {
  assert.equal(isRetriableSendError(networkError()), true);
  assert.equal(isRetriableSendError(Object.assign(new Error('x'), { status: 502 })), true);
  assert.equal(isRetriableSendError(Object.assign(new Error('x'), { status: 404 })), false);
  assert.equal(isRetriableSendError(new Error('plain')), false);
});

test('retries network failures with the same request until it succeeds', async () => {
  let calls = 0;
  const retries = [];
  const result = await sendWithRetry(async () => {
    calls += 1;
    if (calls < 3) throw networkError();
    return { turnId: 't1' };
  }, { wait: noWait, onRetry: ({ attempt }) => retries.push(attempt) });
  assert.deepEqual(result, { turnId: 't1' });
  assert.deepEqual(retries, [1, 2]);
});

test('does not retry business errors', async () => {
  let calls = 0;
  await assert.rejects(sendWithRetry(async () => {
    calls += 1;
    throw Object.assign(new Error('Project not found'), { status: 404 });
  }, { wait: noWait }), /Project not found/);
  assert.equal(calls, 1);
});

test('gives up after the last delay or when told to stop', async () => {
  let calls = 0;
  await assert.rejects(sendWithRetry(async () => { calls += 1; throw networkError(); }, { delays: [1, 1], wait: noWait }));
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(sendWithRetry(async () => { calls += 1; throw networkError(); }, { wait: noWait, shouldContinue: () => false }));
  assert.equal(calls, 1);
});

test('waitForRetry wakes early when the browser comes back online', async () => {
  const target = new EventTarget();
  const started = Date.now();
  const waiting = waitForRetry(60000, target);
  target.dispatchEvent(new Event('online'));
  await waiting;
  assert.ok(Date.now() - started < 1000);
});
