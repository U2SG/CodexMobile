import assert from 'node:assert/strict';
import test from 'node:test';

import {
  queueBodyForSession,
  queueQueryForSession
} from './useQueueDrafts.js';

test('queueQueryForSession targets real sessions by sessionId', () => {
  assert.equal(queueQueryForSession({ id: 'thread 1' }), 'sessionId=thread%201');
});

test('queueQueryForSession targets draft sessions by draftSessionId', () => {
  assert.equal(queueQueryForSession({ id: 'draft-project-1-1', draft: true }), 'draftSessionId=draft-project-1-1');
});

test('queueBodyForSession separates real and draft sessions', () => {
  assert.deepEqual(queueBodyForSession({ id: 'thread-1' }), {
    sessionId: 'thread-1',
    draftSessionId: null
  });
  assert.deepEqual(queueBodyForSession({ id: 'draft-project-1-1' }), {
    sessionId: null,
    draftSessionId: 'draft-project-1-1'
  });
});
