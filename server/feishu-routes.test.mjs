import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createFeishuRoutes } from './feishu-routes.js';

let server;
let baseUrl;
let tmpDir;
let authStatePath;
let calls;
let getLarkDocsStatusImpl;
let startLarkCliAuthImpl;
let logoutLarkCliImpl;

function startTestServer(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const ctx = { method: req.method, pathname: url.pathname, url };
      const preHandled = await routes.preAuthHandle(req, res, ctx);
      if (preHandled) return;
      const postHandled = await routes.postAuthHandle(req, res, ctx);
      if (!postHandled) {
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-routes-'));
  authStatePath = path.join(tmpDir, 'feishu-auth.json');
  calls = { docsStatus: 0, cliStart: 0, cliLogout: 0 };
  getLarkDocsStatusImpl = async ({ authenticated }) => ({
    provider: 'feishu',
    integration: 'lark-cli',
    label: '飞书文档',
    configured: true,
    connected: Boolean(authenticated),
    user: null,
    cliInstalled: true,
    skillsInstalled: true
  });
  startLarkCliAuthImpl = async () => ({ verificationUrl: 'https://example/auth', userCode: 'ABC-DEF' });
  logoutLarkCliImpl = async () => ({});
  const routes = createFeishuRoutes({
    config: {
      appId: 'cli-test-app',
      appSecret: 'cli-test-secret',
      authStatePath,
      authStateMaxAgeMs: 15 * 60 * 1000,
      docsHomeUrl: 'https://docs.feishu.cn/',
      publicUrl: 'http://test.local'
    },
    port: 3321,
    getLarkDocsStatus: async (opts) => { calls.docsStatus += 1; return await getLarkDocsStatusImpl(opts); },
    startLarkCliAuth: async () => { calls.cliStart += 1; return await startLarkCliAuthImpl(); },
    logoutLarkCli: async () => { calls.cliLogout += 1; return await logoutLarkCliImpl(); },
    remoteAddress: () => '127.0.0.1'
  });
  await routes.loadState(); // creates fresh state since file doesn't exist
  ({ srv: server, baseUrl } = await startTestServer(routes));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('GET /api/feishu/status returns the docs status payload', async () => {
  const res = await fetch(`${baseUrl}/api/feishu/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configured, true);
  assert.equal(body.connected, true);
  assert.equal(calls.docsStatus, 1);
});

test('POST /api/feishu/cli/auth/start returns verificationUrl + docs status', async () => {
  const res = await fetch(`${baseUrl}/api/feishu/cli/auth/start`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.verificationUrl, 'https://example/auth');
  assert.equal(body.docs.configured, true);
  assert.equal(calls.cliStart, 1);
});

test('POST /api/feishu/cli/auth/start surfaces error.statusCode', async () => {
  startLarkCliAuthImpl = async () => {
    const err = new Error('cli not installed');
    err.statusCode = 412;
    throw err;
  };
  const res = await fetch(`${baseUrl}/api/feishu/cli/auth/start`, { method: 'POST' });
  assert.equal(res.status, 412);
  const body = await res.json();
  assert.equal(body.error, 'cli not installed');
});

test('POST /api/feishu/auth/start mints a state token + returns redirect URL', async () => {
  const res = await fetch(`${baseUrl}/api/feishu/auth/start`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.url.startsWith('https://open.feishu.cn/'));
  const stateMatch = body.url.match(/state=([^&]+)/);
  assert.ok(stateMatch, 'auth URL should include state param');
  assert.equal(body.redirectUri, 'http://test.local/api/feishu/auth/callback');

  // State should be persisted
  const raw = await fs.readFile(authStatePath, 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(parsed.pendingStates[stateMatch[1]], 'state should be saved to disk');
});

test('POST /api/feishu/auth/start refuses when not configured', async () => {
  const routes = createFeishuRoutes({
    config: { appId: '', appSecret: '', authStatePath, docsHomeUrl: '', publicUrl: '' },
    port: 3321,
    getLarkDocsStatus: getLarkDocsStatusImpl,
    startLarkCliAuth: startLarkCliAuthImpl,
    logoutLarkCli: logoutLarkCliImpl,
    remoteAddress: () => '127.0.0.1'
  });
  await routes.loadState();
  server.close();
  ({ srv: server, baseUrl } = await startTestServer(routes));
  const res = await fetch(`${baseUrl}/api/feishu/auth/start`, { method: 'POST' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /not configured/);
});

test('GET /api/feishu/auth/callback rejects an unknown state', async () => {
  const res = await fetch(`${baseUrl}/api/feishu/auth/callback?state=bogus`);
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.match(text, /授权已过期/);
});

test('POST /api/feishu/auth/logout clears the saved token', async () => {
  // Pre-populate a token
  await fs.writeFile(authStatePath, JSON.stringify({
    token: { accessToken: 'tok', expiresAt: Date.now() + 60_000 },
    pendingStates: {}
  }), 'utf8');
  // New routes instance to reload state from disk
  const routes = createFeishuRoutes({
    config: { appId: 'a', appSecret: 's', authStatePath, docsHomeUrl: '', publicUrl: 'http://test.local' },
    port: 3321,
    getLarkDocsStatus: getLarkDocsStatusImpl,
    startLarkCliAuth: startLarkCliAuthImpl,
    logoutLarkCli: logoutLarkCliImpl,
    remoteAddress: () => '127.0.0.1'
  });
  await routes.loadState();
  server.close();
  ({ srv: server, baseUrl } = await startTestServer(routes));
  const res = await fetch(`${baseUrl}/api/feishu/auth/logout`, { method: 'POST' });
  assert.equal(res.status, 200);
  const persisted = JSON.parse(await fs.readFile(authStatePath, 'utf8'));
  assert.equal(persisted.token, null);
});

test('returns false (passthrough) for unrelated paths', async () => {
  const res = await fetch(`${baseUrl}/api/other`);
  assert.equal(res.status, 404);
});
