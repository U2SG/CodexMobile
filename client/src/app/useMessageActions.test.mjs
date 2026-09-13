import assert from 'node:assert/strict';
import test from 'node:test';

import { restoreDeletedMessage } from './useMessageActions.js';

test('restoreDeletedMessage returns current unchanged when message id is already present', () => {
  const current = [{ id: 'a' }, { id: 'b' }];
  const next = restoreDeletedMessage(current, {
    messageId: 'b',
    removedMessage: { id: 'b' },
    existingIndex: 1
  });
  assert.equal(next, current);
});

test('restoreDeletedMessage re-inserts at the original index when it still fits', () => {
  const removed = { id: 'b', body: 'second' };
  const current = [{ id: 'a' }, { id: 'c' }];
  const next = restoreDeletedMessage(current, {
    messageId: 'b',
    removedMessage: removed,
    existingIndex: 1
  });
  assert.deepEqual(
    next.map((m) => m.id),
    ['a', 'b', 'c']
  );
  assert.equal(next[1], removed);
});

test('restoreDeletedMessage appends when existingIndex is -1 (message was not found at delete time)', () => {
  const removed = { id: 'z' };
  const current = [{ id: 'a' }, { id: 'b' }];
  const next = restoreDeletedMessage(current, {
    messageId: 'z',
    removedMessage: removed,
    existingIndex: -1
  });
  assert.deepEqual(
    next.map((m) => m.id),
    ['a', 'b', 'z']
  );
});

test('restoreDeletedMessage clamps existingIndex to current.length when the list shrank', () => {
  const removed = { id: 'd' };
  const current = [{ id: 'a' }]; // list lost b and c between delete and restore
  const next = restoreDeletedMessage(current, {
    messageId: 'd',
    removedMessage: removed,
    existingIndex: 3
  });
  assert.deepEqual(
    next.map((m) => m.id),
    ['a', 'd']
  );
});
