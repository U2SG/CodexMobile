import assert from 'node:assert/strict';
import test from 'node:test';

import { formatElapsed, runContextLine, runStatusText } from './runs-overview-format.js';

const now = Date.parse('2026-11-11T08:10:00.000Z');

test('formats elapsed time compactly', () => {
  assert.equal(formatElapsed('2026-11-11T08:09:30.000Z', now), '30s');
  assert.equal(formatElapsed('2026-11-11T08:07:00.000Z', now), '3m');
  assert.equal(formatElapsed('2026-11-11T06:05:00.000Z', now), '2h5m');
  assert.equal(formatElapsed(null, now), '');
});

test('status text per kind', () => {
  assert.equal(runStatusText({ status: 'running', startedAt: '2026-11-11T08:07:00.000Z' }, now), '运行中 3m');
  assert.equal(runStatusText({ status: 'approval' }, now), '等待审批');
  assert.equal(runStatusText({ status: 'queued', queued: 2 }, now), '排队 2 条');
});

test('context line skips missing parts', () => {
  assert.equal(runContextLine({ projectName: 'app', worktree: 'login-fix', branch: 'feat/login' }), 'app · login-fix · feat/login');
  assert.equal(runContextLine({ projectName: 'app', worktree: null, branch: 'main' }), 'app · main');
});
