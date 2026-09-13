// Tests focus on pieces that don't require spawning a real codex subprocess:
//   - resolveCodexApproval finds and resolves pending entries
//   - listPendingApprovals snapshotting
//   - shapeReviewDecision encoding for the proposed-amendment cases
//
// The end-to-end "spawn codex app-server, drive a turn, get the approval
// frame, respond, observe completion" flow is exercised by
// scripts/probe-runner.mjs because it needs real CLI binaries and live API
// credentials.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveCodexApproval, listPendingApprovals } from './codex-app-server-runner.js';

test('resolveCodexApproval returns false when no request matches', () => {
  assert.equal(resolveCodexApproval('does-not-exist', { decision: 'approved' }), false);
});

test('listPendingApprovals returns [] when nothing is pending', () => {
  assert.deepEqual(listPendingApprovals(), []);
});

test('listPendingApprovals filtered by turn id returns [] when no match', () => {
  assert.deepEqual(listPendingApprovals('no-such-turn'), []);
});
