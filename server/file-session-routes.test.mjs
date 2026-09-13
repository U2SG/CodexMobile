import { strict as assert } from 'node:assert';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { createFileSessionRoutes } from './file-session-routes.js';

let server;
let baseUrl;
let fileSessionIndex;
let projects;

function startTestServer(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);
      const ctx = { method: req.method, pathname: url.pathname, parts, url };
      const handled = await routes(req, res, ctx);
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not handled' }));
      }
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function call(method, pathName) {
  const response = await fetch(`${baseUrl}${pathName}`, { method });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  projects = new Map([['p1', { id: 'p1', name: 'one', path: 'C:/repo' }]]);
  fileSessionIndex = {
    getSessionsForFile: async () => [
      { sessionId: 's1', touchedAt: 1234, op: 'update', cwd: 'C:/repo' }
    ],
    getFilesForSession: async () => ({
      cwd: 'C:/repo',
      files: [{ path: 'C:/repo/src/foo.js', op: 'update', touchedAt: 100 }]
    })
  };
  const routes = createFileSessionRoutes({
    fileSessionIndex,
    getProject: (id) => projects.get(id) || null
  });
  ({ srv: server, baseUrl } = await startTestServer(routes));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('GET /api/files/sessions returns sessions for the file', async () => {
  const { status, body } = await call('GET', '/api/files/sessions?projectId=p1&path=src/foo.js');
  assert.equal(status, 200);
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].sessionId, 's1');
});

test('resolves project path + relative path to absPath before querying', async () => {
  let observedAbsPath = null;
  fileSessionIndex.getSessionsForFile = async (absPath) => {
    observedAbsPath = absPath;
    return [];
  };
  await call('GET', '/api/files/sessions?projectId=p1&path=src/foo.js');
  assert.equal(observedAbsPath, path.resolve('C:/repo', 'src/foo.js'));
});

test('limit query parameter caps at 20 and floors at 1', async () => {
  let observedLimit = null;
  fileSessionIndex.getSessionsForFile = async (_p, opts) => {
    observedLimit = opts?.limit;
    return [];
  };
  await call('GET', '/api/files/sessions?projectId=p1&path=x&limit=100');
  assert.equal(observedLimit, 20);
  await call('GET', '/api/files/sessions?projectId=p1&path=x&limit=0');
  assert.equal(observedLimit, 5, 'invalid limit falls back to default 5');
  await call('GET', '/api/files/sessions?projectId=p1&path=x&limit=3');
  assert.equal(observedLimit, 3);
});

test('400 when projectId missing', async () => {
  const { status } = await call('GET', '/api/files/sessions?path=x');
  assert.equal(status, 400);
});

test('400 when path missing', async () => {
  const { status } = await call('GET', '/api/files/sessions?projectId=p1');
  assert.equal(status, 400);
});

test('404 when project unknown', async () => {
  const { status, body } = await call('GET', '/api/files/sessions?projectId=ghost&path=x');
  assert.equal(status, 404);
  assert.match(body.error, /not found/i);
});

test('400 when project has no path', async () => {
  projects.set('pathless', { id: 'pathless', name: 'no path' });
  const { status } = await call('GET', '/api/files/sessions?projectId=pathless&path=x');
  assert.equal(status, 400);
});

test('errors from the index propagate as 500 by default', async () => {
  fileSessionIndex.getSessionsForFile = async () => {
    throw new Error('disk boom');
  };
  const { status, body } = await call('GET', '/api/files/sessions?projectId=p1&path=x');
  assert.equal(status, 500);
  assert.match(body.error, /boom/);
});

test('non-matching path/method returns false (404 from wrapper)', async () => {
  const { status } = await call('POST', '/api/files/sessions?projectId=p1&path=x');
  assert.equal(status, 404);
  const r2 = await call('GET', '/api/other');
  assert.equal(r2.status, 404);
});

test('GET /api/sessions/:id/files returns reverse-direction file list', async () => {
  const { status, body } = await call('GET', '/api/sessions/abc/files');
  assert.equal(status, 200);
  assert.equal(body.sessionId, 'abc');
  assert.equal(body.cwd, 'C:/repo');
  assert.equal(body.files.length, 1);
  assert.match(body.files[0].path, /foo\.js$/);
});

test('GET /api/sessions/:id/files forwards limit', async () => {
  let observedLimit = null;
  fileSessionIndex.getFilesForSession = async (_id, opts) => {
    observedLimit = opts?.limit;
    return { cwd: null, files: [] };
  };
  await call('GET', '/api/sessions/abc/files?limit=50');
  assert.equal(observedLimit, 50);
  await call('GET', '/api/sessions/abc/files?limit=9999');
  assert.equal(observedLimit, 500, 'caps at 500');
});

test('GET /api/sessions/:id/files returns 200 with empty list for unknown session', async () => {
  fileSessionIndex.getFilesForSession = async () => ({ cwd: null, files: [] });
  const { status, body } = await call('GET', '/api/sessions/ghost/files');
  assert.equal(status, 200);
  assert.deepEqual(body.files, []);
});
