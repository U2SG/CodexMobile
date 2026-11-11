import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRunsOverview, createBranchReader, createRunsOverviewRoutes } from './runs-overview.js';

const sessions = {
  s1: { id: 's1', title: '修复列表排序', projectId: 'p1', cwd: '/repo/app' },
  s2: { id: 's2', title: '重构登录流程', projectId: 'p1', cwd: '/repo/app/.claude/worktrees/login-fix' },
  s3: { id: 's3', title: '写周报', projectId: 'p2', cwd: '/repo/site' }
};
const projects = {
  p1: { id: 'p1', name: 'app', path: '/repo/app' },
  p2: { id: 'p2', name: 'site', path: '/repo/site' }
};
const deps = {
  getSession: (id) => sessions[id] || null,
  getProject: (id) => projects[id] || null,
  readBranch: async (cwd) => (cwd.endsWith('login-fix') ? 'feat/login' : 'main')
};

test('merges runs, approvals and queues per session, approvals first', async () => {
  const runs = await buildRunsOverview({
    ...deps,
    activeRuns: [
      { sessionId: 's1', startedAt: '2026-11-11T08:00:00.000Z', status: 'running' },
      { sessionId: 's2', startedAt: '2026-11-11T08:05:00.000Z', status: 'running' }
    ],
    approvals: [{ sessionId: 's2', requestId: 'r1' }],
    queues: [{ sessionId: 's3', drafts: [{ id: 'd1' }, { id: 'd2' }] }]
  });
  assert.deepEqual(runs.map((r) => [r.sessionId, r.status]), [['s2', 'approval'], ['s1', 'running'], ['s3', 'queued']]);
  assert.deepEqual(runs[0], {
    sessionId: 's2',
    status: 'approval',
    title: '重构登录流程',
    projectId: 'p1',
    projectName: 'app',
    worktree: 'login-fix',
    branch: 'feat/login',
    startedAt: '2026-11-11T08:05:00.000Z',
    approvals: 1,
    queued: 0
  });
  assert.equal(runs[1].worktree, null, 'the project root is not a worktree');
  assert.equal(runs[2].queued, 2);
});

test('falls back to the run previousSessionId and an untitled label', async () => {
  const runs = await buildRunsOverview({
    ...deps,
    activeRuns: [{ previousSessionId: 'unknown', startedAt: '2026-11-11T08:00:00.000Z' }]
  });
  assert.equal(runs[0].sessionId, 'unknown');
  assert.equal(runs[0].title, '未命名会话');
  assert.equal(runs[0].branch, null);
});

test('branch reader caches per directory for the ttl', async () => {
  let clock = 0;
  let calls = 0;
  const read = createBranchReader(async () => { calls += 1; return 'main'; }, { ttlMs: 1000, now: () => clock });
  await read('/repo');
  await read('/repo');
  assert.equal(calls, 1);
  clock = 2000;
  await read('/repo');
  assert.equal(calls, 2);
});

test('route answers only GET /api/runs/overview', async () => {
  const handle = createRunsOverviewRoutes({
    ...deps,
    getActiveRuns: () => [{ sessionId: 's1', startedAt: '2026-11-11T08:00:00.000Z' }],
    listPendingApprovals: () => [],
    listPendingQueues: () => []
  });
  let sent = null;
  const sendJson = (_res, status, body) => { sent = { status, body }; };
  assert.equal(await handle({}, {}, { method: 'POST', pathname: '/api/runs/overview' }, sendJson), false);
  assert.equal(await handle({}, {}, { method: 'GET', pathname: '/api/runs/overview' }, sendJson), true);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.runs[0].title, '修复列表排序');
});
