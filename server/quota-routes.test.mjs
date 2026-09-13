import { strict as assert } from 'node:assert';
import http from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { createQuotaRoutes } from './quota-routes.js';

let server;
let baseUrl;
let calls;
let getCodexQuotaImpl;
let switchCodexAccountImpl;

function startTestServer(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const ctx = { method: req.method, pathname: url.pathname };
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
  calls = { getQuota: 0, switch: [] };
  getCodexQuotaImpl = async () => ({ accounts: [{ id: 'a', windows: [] }], switchingAvailable: true });
  switchCodexAccountImpl = async (id) => ({ accounts: [{ id, active: true }], switchingAvailable: true });
  const routes = createQuotaRoutes({
    getCodexQuota: async () => {
      calls.getQuota += 1;
      return await getCodexQuotaImpl();
    },
    switchCodexAccount: async (id) => {
      calls.switch.push(id);
      return await switchCodexAccountImpl(id);
    },
    remoteAddress: () => '127.0.0.1'
  });
  ({ srv: server, baseUrl } = await startTestServer(routes));
});

afterEach(() => new Promise((resolve) => server.close(resolve)));

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

test('GET /api/quotas/codex returns the quota payload', async () => {
  const res = await fetch(`${baseUrl}/api/quotas/codex`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.switchingAvailable, true);
  assert.equal(body.accounts.length, 1);
  assert.equal(calls.getQuota, 1);
});

test('GET /api/quotas/codex returns 500 when getCodexQuota throws', async () => {
  getCodexQuotaImpl = async () => { throw new Error('upstream down'); };
  const res = await fetch(`${baseUrl}/api/quotas/codex`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'Failed to query Codex quota');
});

test('POST /api/quotas/codex/switch forwards the account id', async () => {
  const { status, body } = await postJson('/api/quotas/codex/switch', { accountId: 'plan-b' });
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(calls.switch, ['plan-b']);
});

test('POST /api/quotas/codex/switch accepts legacy id / name body keys', async () => {
  await postJson('/api/quotas/codex/switch', { id: 'plan-c' });
  await postJson('/api/quotas/codex/switch', { name: 'plan-d' });
  assert.deepEqual(calls.switch, ['plan-c', 'plan-d']);
});

test('POST /api/quotas/codex/switch surfaces error.statusCode when set', async () => {
  switchCodexAccountImpl = async () => {
    const err = new Error('forbidden');
    err.statusCode = 403;
    throw err;
  };
  const { status, body } = await postJson('/api/quotas/codex/switch', { accountId: 'x' });
  assert.equal(status, 403);
  assert.equal(body.error, 'forbidden');
});

test('returns false (passthrough) for unrelated paths', async () => {
  const res = await fetch(`${baseUrl}/api/other`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'Not handled');
});
