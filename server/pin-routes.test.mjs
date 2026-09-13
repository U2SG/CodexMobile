import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createPinStore } from './pinned-sessions.js';
import { createPinRoutes } from './pin-routes.js';

let tmpDir;
let store;
let onMutationCalls;
let session;
let server;
let baseUrl;

function startTestServer(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);
      const ctx = { method: req.method, pathname: url.pathname, parts };
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pin-routes-'));
  store = createPinStore(tmpDir);
  onMutationCalls = 0;
  session = { id: 's-fixture', cwd: '/projects/foo' };
  const routes = createPinRoutes({
    store,
    getSession: (id) => (id === session.id ? session : null),
    onMutation: async () => { onMutationCalls += 1; }
  });
  ({ srv: server, baseUrl } = await startTestServer(routes));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmpDir, { recursive: true, force: true });
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

test('GET /api/pin-folders returns empty list initially', async () => {
  const { status, body } = await call('GET', '/api/pin-folders');
  assert.equal(status, 200);
  assert.deepEqual(body, { folders: [] });
});

test('POST /api/pin-folders creates folder, triggers onMutation', async () => {
  const { status, body } = await call('POST', '/api/pin-folders', { name: 'work' });
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.folder.name, 'work');
  assert.equal(onMutationCalls, 1);
});

test('POST /api/pin-folders rejects empty name with 400', async () => {
  const { status, body } = await call('POST', '/api/pin-folders', { name: '   ' });
  assert.equal(status, 400);
  assert.match(body.error, /name is required/);
  assert.equal(onMutationCalls, 0);
});

test('PATCH /api/pin-folders/:id renames folder', async () => {
  const created = await store.createPinFolder('temp');
  const { status, body } = await call('PATCH', `/api/pin-folders/${created.id}`, { name: 'renamed' });
  assert.equal(status, 200);
  assert.equal(body.folder.name, 'renamed');
  assert.equal(onMutationCalls, 1);
});

test('PATCH /api/pin-folders/:id toggles collapsed', async () => {
  const created = await store.createPinFolder('temp');
  const { body } = await call('PATCH', `/api/pin-folders/${created.id}`, { collapsed: true });
  assert.equal(body.folder.collapsed, true);
});

test('PATCH /api/pin-folders/:id returns 404 for unknown id', async () => {
  const { status } = await call('PATCH', '/api/pin-folders/f_missing', { name: 'x' });
  assert.equal(status, 404);
  assert.equal(onMutationCalls, 0);
});

test('DELETE /api/pin-folders/:id removes the folder', async () => {
  const created = await store.createPinFolder('temp');
  await store.pinSession({ sessionId: session.id, projectPath: session.cwd, folderId: created.id });
  const { status, body } = await call('DELETE', `/api/pin-folders/${created.id}`);
  assert.equal(status, 200);
  assert.equal(body.removed, true);
  const snap = await store.readPinSnapshot();
  assert.equal(snap.folders.length, 0);
  assert.equal(snap.pinned.get(session.id).folderId, null);
  assert.equal(onMutationCalls, 1);
});

test('POST /api/sessions/:id/pin returns 404 when session unknown', async () => {
  const { status } = await call('POST', '/api/sessions/unknown/pin', {});
  assert.equal(status, 404);
  assert.equal(onMutationCalls, 0);
});

test('POST /api/sessions/:id/pin pins with session.cwd as projectPath', async () => {
  const { status, body } = await call('POST', `/api/sessions/${session.id}/pin`, {});
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.pin.projectPath, session.cwd);
  assert.equal(onMutationCalls, 1);
});

test('POST /api/sessions/:id/pin with no body still pins (DELETE-style call)', async () => {
  const response = await fetch(`${baseUrl}/api/sessions/${session.id}/pin`, { method: 'POST' });
  assert.equal(response.status, 200);
});

test('POST /api/sessions/:id/pin into unknown folder returns 404', async () => {
  const { status } = await call('POST', `/api/sessions/${session.id}/pin`, { folderId: 'f_nope' });
  assert.equal(status, 404);
});

test('DELETE /api/sessions/:id/pin removes pin', async () => {
  await store.pinSession({ sessionId: session.id, projectPath: session.cwd });
  const { status, body } = await call('DELETE', `/api/sessions/${session.id}/pin`);
  assert.equal(status, 200);
  assert.equal(body.removed, true);
  const snap = await store.readPinSnapshot();
  assert.equal(snap.pinned.size, 0);
});

test('DELETE /api/sessions/:id/pin removes stale pin when session is unknown', async () => {
  await store.pinSession({ sessionId: 'stale-session', projectPath: '/projects/old' });
  const { status, body } = await call('DELETE', '/api/sessions/stale-session/pin');
  assert.equal(status, 200);
  assert.equal(body.removed, true);
  const snap = await store.readPinSnapshot();
  assert.equal(snap.pinned.size, 0);
});

test('PATCH /api/sessions/:id/pin moves between folders', async () => {
  const a = await store.createPinFolder('A');
  const b = await store.createPinFolder('B');
  await store.pinSession({ sessionId: session.id, projectPath: session.cwd, folderId: a.id });
  const { status, body } = await call('PATCH', `/api/sessions/${session.id}/pin`, { folderId: b.id });
  assert.equal(status, 200);
  assert.equal(body.pin.folderId, b.id);
});

test('PATCH /api/sessions/:id/pin with folderId:null moves to ungrouped', async () => {
  const a = await store.createPinFolder('A');
  await store.pinSession({ sessionId: session.id, projectPath: session.cwd, folderId: a.id });
  const { body } = await call('PATCH', `/api/sessions/${session.id}/pin`, { folderId: null });
  assert.equal(body.pin.folderId, null);
});

test('non-pin paths return false (not handled)', async () => {
  const { status } = await call('GET', '/api/something-else');
  assert.equal(status, 404);
  // 404 here is from our wrapper "Not handled", not from the routes module.
});
