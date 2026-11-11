import assert from 'node:assert/strict';
import test from 'node:test';

import { createAssistantFrameThrottle } from './assistant-frame-throttle.js';

const update = (messageId, content, extra = {}) => ({ type: 'assistant-update', turnId: 't1', messageId, content, ...extra });

test('sends only the newest snapshot per message after the interval', async () => {
  const sent = [];
  const throttle = createAssistantFrameThrottle({ deliver: (f) => sent.push(f), intervalMs: 10 });
  throttle.send(update('m1', 'a'));
  throttle.send(update('m1', 'ab'));
  throttle.send(update('m2', 'x'));
  throttle.send(update('m1', 'abc'));
  assert.equal(sent.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(sent.map((f) => `${f.messageId}:${f.content}`), ['m1:abc', 'm2:x']);
});

test('any other frame flushes held snapshots first, preserving order', () => {
  const sent = [];
  const throttle = createAssistantFrameThrottle({ deliver: (f) => sent.push(f), intervalMs: 1000 });
  throttle.send(update('m1', 'partial'));
  throttle.send(update('m1', 'final', { done: true }));
  throttle.send({ type: 'chat-complete', turnId: 't1' });
  assert.deepEqual(sent.map((f) => f.content ?? f.type), ['partial', 'final', 'chat-complete']);
});
