import { strict as assert } from 'node:assert';
import http from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { createFileRouteHandler } from './file-routes.js';

let server;
let baseUrl;
let projects;
let lastSearch;

function startTestServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const handled = await handler(req, res, url);
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
  projects = new Map([['p1', { id: 'p1', path: '/proj1' }]]);
  lastSearch = null;
  const handler = createFileRouteHandler({
    getProject: (id) => projects.get(id) || null,
    searchProjectFiles: async (project, query) => {
      lastSearch = { project, query };
      return [
        { name: 'App.jsx', path: `${project.path}/src/App.jsx`, relativePath: 'src/App.jsx' }
      ];
    }
  });
  ({ srv: server, baseUrl } = await startTestServer(handler));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function callJson(pathName) {
  const res = await fetch(`${baseUrl}${pathName}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('GET /api/files/search returns files for known project', async () => {
  const { status, body } = await callJson('/api/files/search?projectId=p1&q=app');
  assert.equal(status, 200);
  assert.equal(body.files.length, 1);
  assert.equal(body.files[0].relativePath, 'src/App.jsx');
  assert.equal(lastSearch.query, 'app');
  assert.equal(lastSearch.project.id, 'p1');
});

test('GET /api/files/search returns 404 when project unknown', async () => {
  const { status, body } = await callJson('/api/files/search?projectId=missing&q=app');
  assert.equal(status, 404);
  assert.equal(body.error, 'Project not found');
});

test('GET /api/files/search empty query returns search results unchanged', async () => {
  const { status, body } = await callJson('/api/files/search?projectId=p1');
  assert.equal(status, 200);
  assert.equal(lastSearch.query, '');
  assert.ok(Array.isArray(body.files));
});

test('non-file paths return false (not handled)', async () => {
  const { status } = await callJson('/api/something-else');
  assert.equal(status, 404);
});
