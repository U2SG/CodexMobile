import { strict as assert } from 'node:assert';
import http from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { createSessionRoutes } from './session-routes.js';

let server;
let baseUrl;
let calls;
let deps;

function startTestServer(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);
      const ctx = { method: req.method, pathname: url.pathname, parts, url };
      const handled = await routes(req, res, ctx);
      if (!handled) {
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
  calls = { renames: [], deletes: [], hides: [], reads: [], mutations: 0, messageDeleted: 0 };
  deps = {
    listProjectSessions: (projectId) => projectId === 'p1' ? [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }] : [],
    getProject: (projectId) => projectId === 'p1' ? { id: 'p1', name: 'Proj' } : null,
    getSession: (sessionId) => {
      if (sessionId === 's1') return { id: 's1', projectId: 'p1', cwd: '/p1' };
      if (sessionId === 's2') return { id: 's2', projectId: 'p1', cwd: '/p1' };
      if (sessionId === 's-other') return { id: 's-other', projectId: 'p2', cwd: '/p2' };
      return null;
    },
    renameSession: async (id, projectId, title) => {
      calls.renames.push({ id, projectId, title });
      return { id, projectId, title };
    },
    deleteSession: async (id, projectId) => {
      calls.deletes.push({ id, projectId });
      return { deletedSessionId: id, projectId, hiddenOnly: true };
    },
    hideSessionMessage: async (sessionId, messageId) => {
      calls.hides.push({ sessionId, messageId });
      return { sessionId, messageId, deletedAt: '2026-05-08T00:00:00Z' };
    },
    readSessionMessages: async (sessionId, opts) => {
      calls.reads.push({ sessionId, opts });
      return { messages: [{ id: 'm1' }], total: 1 };
    },
    sessionHasActiveWork: () => false,
    onMutation: async () => { calls.mutations += 1; },
    onMessageDeleted: async () => { calls.messageDeleted += 1; }
  };
  ({ srv: server, baseUrl } = await startTestServer(createSessionRoutes(deps)));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(method, pathName, body) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('GET /api/projects/:id/sessions returns sessions list', async () => {
  const { status, body } = await call('GET', '/api/projects/p1/sessions');
  assert.equal(status, 200);
  assert.equal(body.sessions.length, 2);
});

test('PATCH rename: project not found returns 404', async () => {
  const { status } = await call('PATCH', '/api/projects/p-missing/sessions/s1', { title: 'X' });
  assert.equal(status, 404);
});

test('PATCH rename: session not in project returns 404', async () => {
  const { status } = await call('PATCH', '/api/projects/p1/sessions/s-other', { title: 'X' });
  assert.equal(status, 404);
});

test('PATCH rename: empty title returns 400', async () => {
  const { status, body } = await call('PATCH', '/api/projects/p1/sessions/s1', { title: '   ' });
  assert.equal(status, 400);
  assert.match(body.error, /title is required/i);
});

test('PATCH rename: success calls renameSession and onMutation', async () => {
  const { status, body } = await call('PATCH', '/api/projects/p1/sessions/s1', { title: 'New name' });
  assert.equal(status, 200);
  assert.equal(body.session.title, 'New name');
  assert.equal(calls.renames.length, 1);
  assert.equal(calls.mutations, 1);
});

test('DELETE session: 404 when project missing', async () => {
  const { status } = await call('DELETE', '/api/projects/p-missing/sessions/s1');
  assert.equal(status, 404);
});

test('DELETE session: 409 when running', async () => {
  deps.sessionHasActiveWork = (id) => id === 's1';
  const routes = createSessionRoutes(deps);
  await new Promise((resolve) => server.close(resolve));
  ({ srv: server, baseUrl } = await startTestServer(routes));
  const { status, body } = await call('DELETE', '/api/projects/p1/sessions/s1');
  assert.equal(status, 409);
  assert.match(body.error, /running/i);
});

test('DELETE session: success calls deleteSession and onMutation', async () => {
  const { status, body } = await call('DELETE', '/api/projects/p1/sessions/s1');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.deletedSessionId, 's1');
  assert.equal(calls.deletes.length, 1);
  assert.equal(calls.mutations, 1);
});

test('DELETE message: success calls hideSessionMessage', async () => {
  const { status, body } = await call('DELETE', '/api/sessions/s1/messages/m99');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.messageId, 'm99');
  assert.equal(calls.hides.length, 1);
  assert.equal(calls.messageDeleted, 1);
});

test('GET messages: passes limit/offset/latest options', async () => {
  const { status, body } = await call('GET', '/api/sessions/s1/messages?limit=50&offset=10&latest=1');
  assert.equal(status, 200);
  assert.equal(body.total, 1);
  assert.equal(calls.reads[0].opts.limit, 50);
  assert.equal(calls.reads[0].opts.offset, 10);
  assert.equal(calls.reads[0].opts.latest, true);
});

test('GET messages: defaults latest=true when no offset', async () => {
  await call('GET', '/api/sessions/s1/messages');
  assert.equal(calls.reads[0].opts.limit, 120);
  assert.equal(calls.reads[0].opts.offset, null);
  assert.equal(calls.reads[0].opts.latest, true);
});

test('non-session paths return false (not handled)', async () => {
  const { status } = await call('GET', '/api/something-else');
  assert.equal(status, 404);
});

test('URL-encoded session ids are decoded', async () => {
  const id = 'has space';
  deps.getSession = (sid) => sid === id ? { id, projectId: 'p1', cwd: '/' } : null;
  const routes = createSessionRoutes(deps);
  await new Promise((resolve) => server.close(resolve));
  ({ srv: server, baseUrl } = await startTestServer(routes));
  const { status } = await call('PATCH', `/api/projects/p1/sessions/${encodeURIComponent(id)}`, { title: 'X' });
  assert.equal(status, 200);
  assert.equal(calls.renames[0].id, id);
});
