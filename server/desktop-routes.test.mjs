import { strict as assert } from 'node:assert';
import http from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { createDesktopRoutes } from './desktop-routes.js';

let server;
let baseUrl;
let prefsStore;
let bridgeProbe;
let openThreadIds;

const KNOWN_PREF_KEYS = ['ipcTurnsEnabled', 'someOtherPref'];

function startTestServer(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const ctx = { method: req.method, pathname: url.pathname, url };
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
  prefsStore = {
    state: { ipcTurnsEnabled: false, someOtherPref: 'x' },
    async getAll() { return { ...this.state }; },
    async set(key, value) {
      this.state[key] = value;
      return value;
    }
  };
  bridgeProbe = {
    callCount: 0,
    forceCalls: 0,
    async getStatus({ force = false } = {}) {
      this.callCount += 1;
      if (force) this.forceCalls += 1;
      return { connected: true, mode: 'desktop-ipc', reason: 'ok' };
    }
  };
  openThreadIds = ['thread-1', 'thread-2'];
  const routes = createDesktopRoutes({
    runtimePrefs: prefsStore,
    knownPrefKeys: KNOWN_PREF_KEYS,
    bridgeStatus: bridgeProbe,
    threadTracker: { getOpenThreadIds: () => openThreadIds }
  });
  ({ srv: server, baseUrl } = await startTestServer(routes));
});

afterEach(() => new Promise((resolve) => server.close(resolve)));

test('GET /api/runtime-prefs returns the full prefs snapshot', async () => {
  const res = await fetch(`${baseUrl}/api/runtime-prefs`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ipcTurnsEnabled: false, someOtherPref: 'x' });
});

test('PATCH /api/runtime-prefs updates only the known keys', async () => {
  const res = await fetch(`${baseUrl}/api/runtime-prefs`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ipcTurnsEnabled: true, unknownKey: 'ignored' })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.deepEqual(body.updated, { ipcTurnsEnabled: true });
  assert.equal(body.prefs.ipcTurnsEnabled, true);
  assert.equal(prefsStore.state.ipcTurnsEnabled, true);
  assert.equal(prefsStore.state.unknownKey, undefined);
});

test('PATCH /api/runtime-prefs forwards error.statusCode when set throws', async () => {
  prefsStore.set = async () => {
    const err = new Error('disk full');
    err.statusCode = 507;
    throw err;
  };
  const res = await fetch(`${baseUrl}/api/runtime-prefs`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ipcTurnsEnabled: true })
  });
  assert.equal(res.status, 507);
});

test('GET /api/desktop/status merges bridge status + openThreadIds', async () => {
  const res = await fetch(`${baseUrl}/api/desktop/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.connected, true);
  assert.equal(body.mode, 'desktop-ipc');
  assert.deepEqual(body.openThreadIds, ['thread-1', 'thread-2']);
  assert.equal(bridgeProbe.callCount, 1);
  assert.equal(bridgeProbe.forceCalls, 0);
});

test('GET /api/desktop/status?force=1 forwards the force flag to the probe', async () => {
  await fetch(`${baseUrl}/api/desktop/status?force=1`);
  assert.equal(bridgeProbe.forceCalls, 1);
});

test('returns false (passthrough) for unrelated paths', async () => {
  const res = await fetch(`${baseUrl}/api/other`);
  assert.equal(res.status, 404);
});
