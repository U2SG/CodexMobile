import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantStreamBuffer } from './assistant-stream-buffer.js';

test('coalesces partial updates within the throttle window', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const applied = [];
  const buffer = createAssistantStreamBuffer({ flushIntervalMs: 60 });

  buffer.schedule({ turnId: 't1', messageId: 'm1', content: 'h', done: false }, (p) => applied.push(p));
  buffer.schedule({ turnId: 't1', messageId: 'm1', content: 'he', done: false }, (p) => applied.push(p));
  buffer.schedule({ turnId: 't1', messageId: 'm1', content: 'hel', done: false }, (p) => applied.push(p));
  assert.equal(applied.length, 0, 'no apply within window');

  t.mock.timers.tick(60);
  assert.equal(applied.length, 1, 'one coalesced apply after window');
  assert.equal(applied[0].content, 'hel');
});

test('done payload flushes synchronously and supersedes pending', () => {
  const applied = [];
  const buffer = createAssistantStreamBuffer({ flushIntervalMs: 60 });

  buffer.schedule({ turnId: 't1', messageId: 'm1', content: 'h', done: false }, (p) => applied.push(p));
  buffer.schedule({ turnId: 't1', messageId: 'm1', content: 'hello', done: true }, (p) => applied.push(p));

  assert.equal(applied.length, 1);
  assert.equal(applied[0].content, 'hello');
  assert.equal(applied[0].done, true);
});

test('different turnId/messageId keys do not coalesce', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const applied = [];
  const buffer = createAssistantStreamBuffer({ flushIntervalMs: 60 });

  buffer.schedule({ turnId: 't1', messageId: 'm1', content: 'a', done: false }, (p) => applied.push(p));
  buffer.schedule({ turnId: 't2', messageId: 'm2', content: 'b', done: false }, (p) => applied.push(p));
  t.mock.timers.tick(60);
  assert.equal(applied.length, 2);
});

test('flushAll forces immediate apply of every pending entry', () => {
  const applied = [];
  const buffer = createAssistantStreamBuffer({ flushIntervalMs: 60 });

  buffer.schedule({ turnId: 't1', messageId: 'm1', content: 'a', done: false }, (p) => applied.push(p));
  buffer.schedule({ turnId: 't2', messageId: 'm2', content: 'b', done: false }, (p) => applied.push(p));
  buffer.flushAll();
  assert.equal(applied.length, 2);
});

test('done flushes pending entries from other keys too', () => {
  const applied = [];
  const buffer = createAssistantStreamBuffer({ flushIntervalMs: 60 });

  buffer.schedule({ turnId: 't1', messageId: 'm1', content: 'a', done: false }, (p) => applied.push(p));
  buffer.schedule({ turnId: 't2', messageId: 'm2', content: 'final', done: true }, (p) => applied.push(p));
  assert.equal(applied.length, 2);
  const contents = applied.map((p) => p.content).sort();
  assert.deepEqual(contents, ['a', 'final']);
});

test('schedule after flushAll restarts the timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const applied = [];
  const buffer = createAssistantStreamBuffer({ flushIntervalMs: 60 });

  buffer.schedule({ turnId: 't1', messageId: 'm1', content: 'a', done: false }, (p) => applied.push(p));
  buffer.flushAll();
  applied.length = 0;

  buffer.schedule({ turnId: 't1', messageId: 'm1', content: 'ab', done: false }, (p) => applied.push(p));
  assert.equal(applied.length, 0);
  t.mock.timers.tick(60);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].content, 'ab');
});
