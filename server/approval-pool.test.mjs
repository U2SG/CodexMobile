// Unit tests for the shared approval pool. The pool is agent-agnostic: both
// the Codex app-server runner and the Claude PreToolUse hook register their
// approvals here and resolve them through the same WebSocket round-trip, so
// the contract below is what both code paths depend on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  registerApproval,
  resolveApproval,
  dropApprovalsForTurn,
  listPendingApprovals
} from './approval-pool.js';

test('registerApproval broadcasts the approval frame and resolves with shaped decision', async () => {
  const broadcasts = [];
  const { requestId, promise } = registerApproval({
    turnId: 't1',
    sessionId: 's1',
    method: 'item/commandExecution/requestApproval',
    kind: 'execCommand',
    requestParams: { command: 'curl example.com' },
    shapeDecision: (ui) => ({ decision: ui.decision === 'approved' ? 'accept' : 'decline' }),
    timedOutResponse: () => ({ decision: 'decline' }),
    broadcast: (frame) => broadcasts.push(frame)
  });
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].type, 'approval-request');
  assert.equal(broadcasts[0].kind, 'execCommand');
  assert.equal(broadcasts[0].requestId, requestId);
  assert.equal(resolveApproval(requestId, { decision: 'approved' }), true);
  const shaped = await promise;
  assert.deepEqual(shaped, { decision: 'accept' });
});

test('resolveApproval returns false for an unknown requestId', () => {
  assert.equal(resolveApproval('does-not-exist', { decision: 'denied' }), false);
});

test('dropApprovalsForTurn force-resolves only entries with the matching turnId', async () => {
  const otherTurnId = `other-${Date.now()}-${Math.random()}`;
  const targetTurnId = `target-${Date.now()}-${Math.random()}`;
  const { promise: p1 } = registerApproval({
    turnId: targetTurnId,
    sessionId: 's',
    method: 'm',
    kind: 'execCommand',
    requestParams: {},
    shapeDecision: (ui) => ({ d: ui.decision || 'none' }),
    timedOutResponse: () => ({ d: 'timed' }),
    broadcast: () => null
  });
  const { promise: p2, requestId: rid2 } = registerApproval({
    turnId: otherTurnId,
    sessionId: 's',
    method: 'm',
    kind: 'execCommand',
    requestParams: {},
    shapeDecision: (ui) => ({ d: ui.decision || 'none' }),
    timedOutResponse: () => ({ d: 'timed' }),
    broadcast: () => null
  });
  dropApprovalsForTurn(targetTurnId);
  assert.deepEqual(await p1, { d: 'timed' });
  // p2 still pending — resolve it manually so the test doesn't leak a timer.
  resolveApproval(rid2, { decision: 'approved' });
  assert.deepEqual(await p2, { d: 'approved' });
});

test('signal abort triggers abortResponse (or timedOutResponse if absent)', async () => {
  const ac = new AbortController();
  const { promise } = registerApproval({
    turnId: 't2',
    sessionId: 's',
    method: 'm',
    kind: 'execCommand',
    requestParams: {},
    signal: ac.signal,
    shapeDecision: (ui) => ({ d: ui.decision || 'none' }),
    timedOutResponse: () => ({ d: 'timed' }),
    abortResponse: () => ({ d: 'aborted' }),
    broadcast: () => null
  });
  ac.abort();
  assert.deepEqual(await promise, { d: 'aborted' });
});

test('listPendingApprovals filters by turnId', () => {
  const tagA = `tag-a-${Date.now()}`;
  const tagB = `tag-b-${Date.now()}`;
  const { requestId: ridA } = registerApproval({
    turnId: tagA,
    sessionId: 's',
    method: 'm',
    kind: 'execCommand',
    requestParams: {},
    shapeDecision: () => ({}),
    timedOutResponse: () => ({}),
    broadcast: () => null
  });
  const { requestId: ridB } = registerApproval({
    turnId: tagB,
    sessionId: 's',
    method: 'm',
    kind: 'execCommand',
    requestParams: {},
    shapeDecision: () => ({}),
    timedOutResponse: () => ({}),
    broadcast: () => null
  });
  const onlyA = listPendingApprovals(tagA);
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0].turnId, tagA);
  resolveApproval(ridA, {});
  resolveApproval(ridB, {});
});
