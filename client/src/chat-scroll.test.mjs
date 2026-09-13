import test from 'node:test';
import assert from 'node:assert/strict';

import { isNearChatBottom, shouldFollowChatOutput } from './chat-scroll.js';

test('detects whether the chat pane is pinned near the bottom', () => {
  assert.equal(isNearChatBottom({ scrollHeight: 1200, scrollTop: 620, clientHeight: 500 }), true);
  assert.equal(isNearChatBottom({ scrollHeight: 1200, scrollTop: 420, clientHeight: 500 }), false);
});

test('does not force-follow running output after the user scrolls up', () => {
  assert.equal(shouldFollowChatOutput({ pinnedToBottom: false, running: true }), false);
  assert.equal(shouldFollowChatOutput({ pinnedToBottom: true, running: true }), true);
  assert.equal(shouldFollowChatOutput({ pinnedToBottom: true, running: false }), true);
});

test('allows an explicit session-load scroll to override the pinned state', () => {
  assert.equal(shouldFollowChatOutput({ pinnedToBottom: false, force: true }), true);
});

test('keeps following output when a message replacement temporarily loses the bottom pin', () => {
  assert.equal(
    shouldFollowChatOutput({
      pinnedToBottom: false,
      pinnedBeforeUpdate: true
    }),
    true
  );
});
