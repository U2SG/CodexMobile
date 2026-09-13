import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatQueue } from './chat-queue.js';

test('chat queue serializes queued drafts and removes restored drafts', () => {
  const queue = createChatQueue();
  const queueKey = queue.resolveConversationKey('thread-1');

  const first = queue.enqueueJob({
    queueKey,
    project: { id: 'project-1' },
    selectedSessionId: 'thread-1',
    turnId: 'turn-1',
    displayMessage: '第一条',
    attachments: [{ path: '/tmp/a.txt' }],
    selectedSkills: [{ name: 'Skill', path: '/tmp/SKILL.md' }]
  });
  const second = queue.enqueueJob({
    queueKey,
    project: { id: 'project-1' },
    selectedSessionId: 'thread-1',
    turnId: 'turn-2',
    displayMessage: '第二条'
  });

  assert.equal(first.queued, false);
  assert.equal(second.queued, true);

  const listed = queue.listQueue({ sessionId: 'thread-1' });
  assert.equal(listed.running, false);
  assert.deepEqual(listed.drafts.map((draft) => [draft.id, draft.text]), [
    ['turn-1', '第一条'],
    ['turn-2', '第二条']
  ]);
  assert.equal(listed.drafts[0].attachments.length, 1);
  assert.equal(listed.drafts[0].selectedSkills.length, 1);

  const restored = queue.restoreQueuedDraft({ sessionId: 'thread-1', draftId: 'turn-1' });
  assert.equal(restored.text, '第一条');
  assert.deepEqual(queue.listQueue({ sessionId: 'thread-1' }).drafts.map((draft) => draft.id), ['turn-2']);
});

test('chat queue aliases draft sessions to the final session id', () => {
  const queue = createChatQueue();
  const queueKey = queue.resolveConversationKey('draft-1');
  queue.rememberConversationAlias(queueKey, 'thread-1');
  queue.enqueueJob({
    queueKey,
    project: { id: 'project-1' },
    draftSessionId: 'draft-1',
    selectedSessionId: 'thread-1',
    turnId: 'turn-1',
    displayMessage: '排队消息'
  }, { forceQueued: true });

  assert.deepEqual(queue.listQueue({ draftSessionId: 'draft-1' }).drafts.map((draft) => draft.id), ['turn-1']);
  assert.deepEqual(queue.listQueue({ sessionId: 'thread-1' }).drafts.map((draft) => draft.id), ['turn-1']);
  assert.equal(queue.sessionHasActiveWork('thread-1'), true);
  assert.equal(queue.sessionHasActiveWork('draft-1'), true);
});

test('chat queue remembers turn events and trims old entries', () => {
  const queue = createChatQueue({ maxRecentTurns: 2 });
  queue.rememberTurnEvent({ type: 'chat-started', turnId: 'turn-1', sessionId: 'thread-1' });
  queue.rememberTurnEvent({ type: 'assistant-update', turnId: 'turn-1', content: 'hello' });
  queue.rememberTurnEvent({ type: 'chat-complete', turnId: 'turn-2', sessionId: 'thread-2', usage: { total: 1 } });
  queue.rememberTurnEvent({ type: 'chat-error', turnId: 'turn-3', sessionId: 'thread-3', error: 'failed' });

  assert.equal(queue.getTurn('turn-1'), null);
  assert.equal(queue.getTurn('turn-2').status, 'completed');
  assert.deepEqual(queue.getTurn('turn-2').usage, { total: 1 });
  assert.equal(queue.getTurn('turn-3').status, 'failed');
  assert.equal(queue.sessionHasActiveWork('thread-1'), false);
});
