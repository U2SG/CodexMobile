import { strict as assert } from 'node:assert';
import http from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { createPushRoutes } from './push-routes.js';

let server;
let baseUrl;
let mockService;
let calls;

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
  calls = { subscribe: [], unsubscribe: [], status: 0, sendNotification: [] };
  mockService = {
    async publicStatus() {
      calls.status += 1;
      return { supported: true, subject: 'mailto:test@example.com', publicKey: 'pub-x', subscriberCount: 0 };
    },
    async subscribe(subscription, options) {
      calls.subscribe.push({ subscription, options });
      if (!subscription?.endpoint) {
        const err = new Error('Invalid push subscription');
        err.statusCode = 400;
        throw err;
      }
      return { endpoint: subscription.endpoint, keys: subscription.keys, createdAt: 'fixed', updatedAt: 'fixed', userAgent: options?.userAgent || null, expirationTime: null };
    },
    async unsubscribe(endpoint) {
      calls.unsubscribe.push(endpoint);
      return { removed: endpoint === 'https://push/known' };
    },
    async sendNotification(payload) {
      calls.sendNotification.push(payload);
      return { sent: 3, removed: 0 };
    },
    async notifyForPayload() {
      return { sent: 0, removed: 0 };
    }
  };
  const routes = createPushRoutes({ pushService: mockService });
  ({ srv: server, baseUrl } = await startTestServer(routes));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.NODE_ENV;
});

async function call(method, pathName, body, headers = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('GET /api/notifications/status returns publicStatus', async () => {
  const { status, body } = await call('GET', '/api/notifications/status');
  assert.equal(status, 200);
  assert.equal(body.supported, true);
  assert.equal(body.publicKey, 'pub-x');
  assert.equal(body.subscriberCount, 0);
  assert.equal(calls.status, 1);
});

test('POST /api/notifications/status is not handled (returns false)', async () => {
  const { status } = await call('POST', '/api/notifications/status', {});
  assert.equal(status, 404);
});

test('POST /api/notifications/subscribe persists subscription and forwards user-agent', async () => {
  const { status, body } = await call(
    'POST',
    '/api/notifications/subscribe',
    { endpoint: 'https://push/me', keys: { p256dh: 'p', auth: 'a' } },
    { 'user-agent': 'TestUA/1.0' }
  );
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.subscription.endpoint, 'https://push/me');
  assert.equal(calls.subscribe.length, 1);
  assert.equal(calls.subscribe[0].options.userAgent, 'TestUA/1.0');
});

test('POST /api/notifications/subscribe returns 400 on invalid input', async () => {
  const { status, body } = await call('POST', '/api/notifications/subscribe', { keys: {} });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid push subscription/);
});

test('POST /api/notifications/unsubscribe returns removed:true for known endpoint', async () => {
  const { status, body } = await call('POST', '/api/notifications/unsubscribe', { endpoint: 'https://push/known' });
  assert.equal(status, 200);
  assert.deepEqual(body, { removed: true });
});

test('POST /api/notifications/unsubscribe returns removed:false for unknown endpoint', async () => {
  const { status, body } = await call('POST', '/api/notifications/unsubscribe', { endpoint: 'https://push/missing' });
  assert.equal(status, 200);
  assert.deepEqual(body, { removed: false });
});

test('POST /api/notifications/test triggers a test notification when not in production', async () => {
  delete process.env.NODE_ENV;
  const { status, body } = await call('POST', '/api/notifications/test');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.sent, 3);
  assert.equal(body.removed, 0);
  assert.equal(calls.sendNotification.length, 1);
  assert.match(calls.sendNotification[0].title, /CodexMobile/);
});

test('POST /api/notifications/test returns 404 when NODE_ENV=production', async () => {
  process.env.NODE_ENV = 'production';
  const { status } = await call('POST', '/api/notifications/test');
  assert.equal(status, 404);
  assert.equal(calls.sendNotification.length, 0);
});

test('non-notification paths return false (not handled)', async () => {
  const { status } = await call('GET', '/api/something-else');
  assert.equal(status, 404);
});

test('createPushRoutes throws if pushService missing', () => {
  assert.throws(() => createPushRoutes({}), /pushService is required/);
});
