import { strict as assert } from 'node:assert';
import http from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { createMetaRoutes } from './meta-routes.js';

let server;
let baseUrl;
let calls;
let pairImpl;
let refreshImpl;

function startTestServer(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const ctx = { method: req.method, pathname: url.pathname };
      const pre = await routes.preAuthHandle(req, res, ctx);
      if (pre) return;
      const post = await routes.postAuthHandle(req, res, ctx);
      if (!post) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not handled' }));
      }
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

beforeEach(async () => {
  calls = { status: 0, pair: [], sync: 0, projects: 0, pinned: 0, broadcasts: [], archived: [], restored: [] };
  pairImpl = async ({ code }) => (code === 'good' ? { token: 'tok-x', deviceName: 'd' } : null);
  refreshImpl = async () => ({ syncedAt: '2026-05-15T00:00:00Z', projects: [{ id: 'p1' }] });
  const routes = createMetaRoutes({
    publicStatus: async (authenticated) => {
      calls.status += 1;
      return { connected: true, authenticated };
    },
    isAuthenticated: async () => false,
    pairDevice: async (args) => {
      calls.pair.push(args);
      return await pairImpl(args);
    },
    refreshCodexCache: async () => {
      calls.sync += 1;
      return await refreshImpl();
    },
    broadcast: (payload) => { calls.broadcasts.push(payload); },
    listProjects: () => { calls.projects += 1; return [{ id: 'p1' }, { id: 'p2' }]; },
    getProject: (id) => (id === 'p1' ? { id: 'p1', name: 'one', path: '/repo/one' } : null),
    hideProject: async (project) => {
      calls.archived.push(project);
      return { projectId: project.id, hiddenAt: '2026-05-15T00:00:01Z' };
    },
    restoreProject: async (projectId) => {
      calls.restored.push(projectId);
      return { projectId, restored: true };
    },
    listArchivedProjects: async () => [{ id: 'p3', name: 'old', path: '/repo/old', hiddenAt: '2026-05-14T00:00:00Z' }],
    listPinFolders: async () => [{ id: 'f1' }],
    buildPinnedSessionsResponse: async () => { calls.pinned += 1; return { sessions: [], folders: [] }; },
    listAvailableSkills: async () => { calls.skills = (calls.skills || 0) + 1; return [{ name: 'demo', description: 'd', path: '/tmp/d/SKILL.md', source: 'claude' }]; },
    remoteAddress: () => '127.0.0.1'
  });
  ({ srv: server, baseUrl } = await startTestServer(routes));
});

afterEach(() => new Promise((resolve) => server.close(resolve)));

test('GET /api/status returns the public status (unauthenticated false)', async () => {
  const res = await fetch(`${baseUrl}/api/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.connected, true);
  assert.equal(body.authenticated, false);
  assert.equal(calls.status, 1);
});

test('POST /api/pair returns the token on a valid code', async () => {
  const res = await fetch(`${baseUrl}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'good', deviceName: 'iphone' })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.token, 'tok-x');
  assert.equal(calls.pair[0].code, 'good');
});

test('POST /api/pair returns 403 on an invalid code', async () => {
  const res = await fetch(`${baseUrl}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'bad' })
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'Invalid pairing code');
});

test('POST /api/sync refreshes the cache and broadcasts sync-complete', async () => {
  const res = await fetch(`${baseUrl}/api/sync`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.syncedAt, '2026-05-15T00:00:00Z');
  assert.equal(calls.sync, 1);
  assert.equal(calls.broadcasts[0].type, 'sync-complete');
});

test('GET /api/projects returns the project list + pin folders', async () => {
  const res = await fetch(`${baseUrl}/api/projects`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.projects.length, 2);
  assert.equal(body.pinFolders[0].id, 'f1');
});

test('GET /api/projects/archived returns archived projects', async () => {
  const res = await fetch(`${baseUrl}/api/projects/archived`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.projects[0].id, 'p3');
});

test('DELETE /api/projects/:id archives a project and refreshes cache', async () => {
  const res = await fetch(`${baseUrl}/api/projects/p1`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.projectId, 'p1');
  assert.equal(calls.archived[0].path, '/repo/one');
  assert.equal(calls.sync, 1);
  assert.equal(calls.broadcasts[0].type, 'sync-complete');
});

test('POST /api/projects/archive archives the supplied project when cache lookup misses', async () => {
  const res = await fetch(`${baseUrl}/api/projects/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: { id: 'p-local', name: 'local', path: '/repo/local' } })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.projectId, 'p-local');
  assert.equal(calls.archived[0].path, '/repo/local');
});

test('POST /api/projects/archive rejects missing project id', async () => {
  const res = await fetch(`${baseUrl}/api/projects/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: { name: 'missing id' } })
  });
  assert.equal(res.status, 400);
});

test('POST /api/projects/:id/restore restores a project and refreshes cache', async () => {
  const res = await fetch(`${baseUrl}/api/projects/p3/restore`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.projectId, 'p3');
  assert.deepEqual(calls.restored, ['p3']);
  assert.equal(calls.sync, 1);
});

test('GET /api/pinned-sessions returns the snapshot', async () => {
  const res = await fetch(`${baseUrl}/api/pinned-sessions`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { sessions: [], folders: [] });
  assert.equal(calls.pinned, 1);
});

test('GET /api/skills returns the discovered skills list', async () => {
  const res = await fetch(`${baseUrl}/api/skills`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(Array.isArray(body.skills), true);
  assert.equal(body.skills.length, 1);
  assert.equal(body.skills[0].name, 'demo');
  assert.equal(body.skills[0].source, 'claude');
  assert.equal(calls.skills, 1);
});

test('returns false (passthrough) for unrelated paths', async () => {
  const res = await fetch(`${baseUrl}/api/other`);
  assert.equal(res.status, 404);
});
