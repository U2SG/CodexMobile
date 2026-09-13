import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinnedSessionsView } from './pinned-sessions-view.js';

function makeDeps(overrides = {}) {
  const sessions = overrides.sessions || new Map();
  const projects = overrides.projects || new Map();
  return {
    pinStore: {
      readPinSnapshot: async () => overrides.snapshot || { pinned: new Map(), folders: [] }
    },
    getCacheSnapshot: () => ({ projects: [...projects.values()] }),
    getSession: (id) => sessions.get(id) || null,
    getProject: (id) => projects.get(id) || null,
    filterSession: overrides.filterSession || (() => true)
  };
}

test('factory enforces required deps', () => {
  assert.throws(() => createPinnedSessionsView({}), /pinStore is required/);
  assert.throws(() => createPinnedSessionsView({ pinStore: {}, getCacheSnapshot: () => ({}), getSession: () => null }), /getProject is required/);
});

test('returns empty sessions + folders when nothing is pinned', async () => {
  const view = createPinnedSessionsView(makeDeps());
  const result = await view();
  assert.deepEqual(result, { sessions: [], folders: [] });
});

test('joins pinned session to project cache and includes folders', async () => {
  const sessions = new Map([['s1', {
    id: 's1', title: 'Hi', summary: null, model: 'gpt', provider: 'codex',
    source: 'live', updatedAt: '2026-05-20T00:00:00Z',
    projectId: 'p1', cwd: '/proj/a'
  }]]);
  const projects = new Map([['p1', { id: 'p1', name: 'Proj A', path: '/proj/a' }]]);
  const view = createPinnedSessionsView(makeDeps({
    sessions,
    projects,
    snapshot: {
      pinned: new Map([['s1', { pinnedAt: '2026-05-20T01:00:00Z', folderId: 'f1' }]]),
      folders: [{ id: 'f1', name: 'Saved' }]
    }
  }));

  const result = await view();
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].id, 's1');
  assert.equal(result.sessions[0].projectName, 'Proj A');
  assert.equal(result.sessions[0].folderId, 'f1');
  assert.equal(result.sessions[0].pinned, true);
  assert.deepEqual(result.folders, [{ id: 'f1', name: 'Saved' }]);
});

test('surfaces archived/external pins missing from current session cache', async () => {
  const view = createPinnedSessionsView(makeDeps({
    snapshot: {
      pinned: new Map([['gone', { pinnedAt: '2026-05-15T00:00:00Z', folderId: null, projectPath: '/proj/x' }]]),
      folders: []
    }
  }));
  const result = await view();
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].id, 'gone');
  assert.equal(result.sessions[0].title, '对话');
  assert.equal(result.sessions[0].projectPath, '/proj/x');
});

test('sorts by pinnedAt desc', async () => {
  const view = createPinnedSessionsView(makeDeps({
    snapshot: {
      pinned: new Map([
        ['old', { pinnedAt: '2026-01-01T00:00:00Z' }],
        ['new', { pinnedAt: '2026-06-01T00:00:00Z' }],
        ['mid', { pinnedAt: '2026-03-01T00:00:00Z' }]
      ]),
      folders: []
    }
  }));
  const result = await view();
  assert.deepEqual(result.sessions.map((s) => s.id), ['new', 'mid', 'old']);
});

test('filterSession drops cross-agent pins', async () => {
  const sessions = new Map([
    ['codex-s', { id: 'codex-s', provider: 'codex' }],
    ['claude-s', { id: 'claude-s', provider: 'claude' }]
  ]);
  const view = createPinnedSessionsView(makeDeps({
    sessions,
    snapshot: {
      pinned: new Map([
        ['codex-s', { pinnedAt: '2026-05-20T00:00:00Z' }],
        ['claude-s', { pinnedAt: '2026-05-20T00:00:00Z' }]
      ]),
      folders: []
    },
    filterSession: (s) => s.provider === 'claude'
  }));
  const result = await view();
  assert.deepEqual(result.sessions.map((s) => s.id), ['claude-s']);
});
