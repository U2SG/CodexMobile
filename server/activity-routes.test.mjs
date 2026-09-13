import { strict as assert } from 'node:assert';
import http from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';

import { createActivityRoutes } from './activity-routes.js';

let server;
let baseUrl;
let fileSessionIndex;

function startTestServer(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const handled = await routes(req, res, {
        method: req.method,
        pathname: url.pathname,
        parts: url.pathname.split('/').filter(Boolean),
        url
      });
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not handled"}');
      }
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function call(pathName) {
  const response = await fetch(`${baseUrl}${pathName}`);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  fileSessionIndex = {
    aggregateActivity: async () => ({
      days: [
        { date: '2026-05-16', sessionCount: 2, fileCount: 5, projectCount: 1, byAgent: { codex: { sessions: 2, files: 5 } } }
      ],
      totals: { sessions: 2, files: 5, projects: 1, byAgent: { codex: { sessions: 2, files: 5 } } }
    })
  };
  const routes = createActivityRoutes({ fileSessionIndex });
  ({ srv: server, baseUrl } = await startTestServer(routes));
});

afterEach(async () => {
  if (server) await new Promise((r) => server.close(r));
});

test('createActivityRoutes throws when fileSessionIndex lacks aggregateActivity', () => {
  assert.throws(() => createActivityRoutes({ fileSessionIndex: {} }), /aggregateActivity is required/);
  assert.throws(() => createActivityRoutes({}), /aggregateActivity is required/);
});

test('GET /api/activity returns activity payload with defaults', async () => {
  const { status, body } = await call('/api/activity');
  assert.equal(status, 200);
  assert.equal(body.days, 7);
  assert.equal(body.agent, 'all');
  assert.equal(body.activity.days.length, 1);
  assert.equal(body.activity.totals.sessions, 2);
});

test('GET /api/activity forwards days + agent filter to aggregateActivity', async () => {
  let observed = null;
  fileSessionIndex.aggregateActivity = async (opts) => {
    observed = opts;
    return { days: [], totals: { sessions: 0, files: 0, projects: 0, byAgent: {} } };
  };
  await call('/api/activity?days=30&agent=claude');
  assert.ok(observed.sinceMs > 0);
  assert.equal(observed.agentFilter, 'claude');
});

test('GET /api/activity clamps days into [1, 365]', async () => {
  let observed = null;
  fileSessionIndex.aggregateActivity = async (opts) => {
    observed = opts;
    return { days: [], totals: { sessions: 0, files: 0, projects: 0, byAgent: {} } };
  };
  const before = Date.now();
  await call('/api/activity?days=99999');
  const cutoff = observed.sinceMs;
  // sinceMs should correspond to ~365 days ago.
  const elapsed = before - cutoff;
  const oneDay = 24 * 60 * 60 * 1000;
  assert.ok(elapsed >= 365 * oneDay - 60_000);
  assert.ok(elapsed <= 365 * oneDay + 60_000);
});

test('GET /api/activity treats unknown agent value as "all"', async () => {
  let observed = null;
  fileSessionIndex.aggregateActivity = async (opts) => {
    observed = opts;
    return { days: [], totals: { sessions: 0, files: 0, projects: 0, byAgent: {} } };
  };
  await call('/api/activity?agent=bogus');
  assert.equal(observed.agentFilter, null);
});

test('GET /api/activity propagates aggregator errors as 500', async () => {
  fileSessionIndex.aggregateActivity = async () => {
    throw new Error('boom');
  };
  const { status, body } = await call('/api/activity');
  assert.equal(status, 500);
  assert.match(body.error, /boom/);
});

test('non-matching paths return false (404 from wrapper)', async () => {
  const { status } = await call('/api/other');
  assert.equal(status, 404);
});
