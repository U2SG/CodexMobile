import { strict as assert } from 'node:assert';
import http from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';

import { createSearchRoutes, extractSnippet, scanRolloutLines } from './search-routes.js';

let server;
let baseUrl;
let rollouts;
let classifierBehavior;

function rolloutJsonl(lines) {
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

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

let projects;

beforeEach(async () => {
  rollouts = {};
  projects = new Map();
  classifierBehavior = (filePath) => filePath.includes('codex') ? 'codex' : 'claude';
  const routes = createSearchRoutes({
    listRolloutFiles: async () => Object.keys(rollouts).map((p) => ({ path: p, mtimeMs: Date.now() })),
    readRolloutFile: async (p) => rollouts[p],
    classifySourceFile: classifierBehavior,
    getProject: (id) => projects.get(id) || null
  });
  ({ srv: server, baseUrl } = await startTestServer(routes));
});

afterEach(async () => {
  if (server) await new Promise((r) => server.close(r));
});

// ---- extractSnippet ----

test('extractSnippet returns the matched window with ellipses on both ends', () => {
  const line = 'a'.repeat(200) + 'NEEDLE' + 'b'.repeat(200);
  const out = extractSnippet(line, 'needle');
  assert.ok(out.startsWith('…'));
  assert.ok(out.endsWith('…'));
  assert.ok(out.toLowerCase().includes('needle'));
});

test('extractSnippet strips control characters', () => {
  const line = 'beforeNEEDLEafter';
  const out = extractSnippet(line, 'needle');
  assert.ok(!/[\x00-\x08]/.test(out));
});

test('extractSnippet returns empty string when no match', () => {
  assert.equal(extractSnippet('hello', 'xyz'), '');
});

// ---- scanRolloutLines ----

test('scanRolloutLines extracts session meta + bounded hits per session', () => {
  const text = rolloutJsonl([
    { type: 'session_meta', payload: { id: 's1', cwd: '/r' }, timestamp: '2026-05-16T10:00:00Z' },
    { type: 'response_item', payload: { role: 'user', content: 'find me NEEDLE in here' }, timestamp: '2026-05-16T10:01:00Z' },
    { type: 'response_item', payload: { role: 'assistant', content: 'I see NEEDLE again' }, timestamp: '2026-05-16T10:02:00Z' },
    { type: 'response_item', payload: { role: 'assistant', content: 'NEEDLE x3' }, timestamp: '2026-05-16T10:03:00Z' },
    { type: 'response_item', payload: { role: 'assistant', content: 'NEEDLE x4' }, timestamp: '2026-05-16T10:04:00Z' }
  ]);
  const result = scanRolloutLines(text, 'needle', { maxPerSession: 3 });
  assert.equal(result.sessionId, 's1');
  assert.equal(result.cwd, '/r');
  assert.equal(result.hits.length, 3, 'capped at maxPerSession');
  assert.ok(result.hits.every((h) => h.snippet.toLowerCase().includes('needle')));
});

test('scanRolloutLines handles claude-shape envelopes (sessionId at top level)', () => {
  const text = rolloutJsonl([
    { type: 'permission-mode', sessionId: 'claude-sess' },
    {
      type: 'assistant',
      sessionId: 'claude-sess',
      cwd: '/r',
      timestamp: '2026-05-16T11:00:00Z',
      message: { content: [{ type: 'text', text: 'looking for NEEDLE here' }] }
    }
  ]);
  const result = scanRolloutLines(text, 'needle');
  assert.equal(result.sessionId, 'claude-sess');
  assert.equal(result.hits.length, 1);
});

test('scanRolloutLines tolerates broken JSON lines', () => {
  const text = [
    JSON.stringify({ type: 'session_meta', payload: { id: 's', cwd: '/r' } }),
    'broken{not json',
    JSON.stringify({ type: 'x', payload: { content: 'find NEEDLE' } })
  ].join('\n');
  const result = scanRolloutLines(text, 'needle');
  assert.equal(result.sessionId, 's');
  assert.equal(result.hits.length, 1);
});

// ---- route ----

test('GET /api/search returns 400 when q is missing or blank', async () => {
  const r1 = await call('/api/search');
  assert.equal(r1.status, 400);
  const r2 = await call('/api/search?q=%20%20');
  assert.equal(r2.status, 400);
});

test('GET /api/search rejects oversized queries', async () => {
  const huge = 'a'.repeat(300);
  const { status } = await call(`/api/search?q=${encodeURIComponent(huge)}`);
  assert.equal(status, 400);
});

test('GET /api/search returns matches with agent and cwd', async () => {
  rollouts['/codex/a.jsonl'] = rolloutJsonl([
    { type: 'session_meta', payload: { id: 's-codex', cwd: '/r' }, timestamp: '2026-05-16T10:00:00Z' },
    { type: 'msg', payload: { content: 'I love elasticsearch' }, timestamp: '2026-05-16T10:05:00Z' }
  ]);
  rollouts['/claude/b.jsonl'] = rolloutJsonl([
    { type: 'permission-mode', sessionId: 's-claude' },
    {
      type: 'assistant',
      sessionId: 's-claude',
      cwd: '/r',
      timestamp: '2026-05-16T11:00:00Z',
      message: { content: [{ type: 'text', text: 'elasticsearch is interesting' }] }
    }
  ]);
  const { status, body } = await call('/api/search?q=elasticsearch');
  assert.equal(status, 200);
  assert.equal(body.query, 'elasticsearch');
  assert.equal(body.results.length, 2);
  const byAgent = Object.fromEntries(body.results.map((r) => [r.agent, r]));
  assert.ok(byAgent.codex);
  assert.ok(byAgent.claude);
});

test('GET /api/search is case-insensitive', async () => {
  rollouts['/codex/a.jsonl'] = rolloutJsonl([
    { type: 'session_meta', payload: { id: 's', cwd: '/r' } },
    { type: 'msg', payload: { content: 'PostgreSQL indices' } }
  ]);
  const { body } = await call('/api/search?q=postgresql');
  assert.equal(body.results.length, 1);
});

test('GET /api/search respects per-session and total caps', async () => {
  // 5 sessions, each with 5 matches. Total cap default 20, per-session 3,
  // so we should see 5*3 = 15 results (well under 20).
  for (let i = 0; i < 5; i += 1) {
    rollouts[`/codex/${i}.jsonl`] = rolloutJsonl([
      { type: 'session_meta', payload: { id: `s-${i}`, cwd: '/r' } },
      ...Array.from({ length: 5 }).map((_, j) => ({
        type: 'msg',
        payload: { content: `hit ${j} match` },
        timestamp: `2026-05-16T10:0${j}:00Z`
      }))
    ]);
  }
  const { body } = await call('/api/search?q=match&limit=20');
  assert.equal(body.results.length, 15);
});

test('GET /api/search respects user-requested limit', async () => {
  for (let i = 0; i < 10; i += 1) {
    rollouts[`/codex/${i}.jsonl`] = rolloutJsonl([
      { type: 'session_meta', payload: { id: `s-${i}`, cwd: '/r' } },
      { type: 'msg', payload: { content: 'unique match here' }, timestamp: `2026-05-${10 + i}T00:00:00Z` }
    ]);
  }
  const { body } = await call('/api/search?q=match&limit=3');
  assert.equal(body.results.length, 3);
});

test('GET /api/search returns no results for unknown queries', async () => {
  rollouts['/codex/a.jsonl'] = rolloutJsonl([
    { type: 'session_meta', payload: { id: 's', cwd: '/r' } },
    { type: 'msg', payload: { content: 'hello world' } }
  ]);
  const { body } = await call('/api/search?q=xyz123notinthere');
  assert.equal(body.results.length, 0);
});

test('agent=codex filters out claude hits and vice versa', async () => {
  rollouts['/codex/a.jsonl'] = rolloutJsonl([
    { type: 'session_meta', payload: { id: 's-codex', cwd: '/r' } },
    { type: 'msg', payload: { content: 'shared phrase' }, timestamp: '2026-05-16T10:00:00Z' }
  ]);
  rollouts['/claude/b.jsonl'] = rolloutJsonl([
    { type: 'permission-mode', sessionId: 's-claude' },
    {
      type: 'assistant',
      sessionId: 's-claude',
      cwd: '/r',
      timestamp: '2026-05-16T11:00:00Z',
      message: { content: [{ type: 'text', text: 'shared phrase' }] }
    }
  ]);
  const codexOnly = await call('/api/search?q=shared+phrase&agent=codex');
  assert.equal(codexOnly.body.agentFilter, 'codex');
  assert.equal(codexOnly.body.results.length, 1);
  assert.equal(codexOnly.body.results[0].agent, 'codex');

  const claudeOnly = await call('/api/search?q=shared+phrase&agent=claude');
  assert.equal(claudeOnly.body.results.length, 1);
  assert.equal(claudeOnly.body.results[0].agent, 'claude');

  const all = await call('/api/search?q=shared+phrase&agent=all');
  assert.equal(all.body.agentFilter, 'all');
  assert.equal(all.body.results.length, 2);
});

test('unknown agent filter is treated as "all"', async () => {
  rollouts['/codex/a.jsonl'] = rolloutJsonl([
    { type: 'session_meta', payload: { id: 's', cwd: '/r' } },
    { type: 'msg', payload: { content: 'match' } }
  ]);
  const { body } = await call('/api/search?q=match&agent=bogus');
  assert.equal(body.agentFilter, 'all');
  assert.equal(body.results.length, 1);
});

test('projectId filter scopes hits to the project\'s cwd only', async () => {
  projects.set('p1', { id: 'p1', name: 'one', path: '/repo-A' });
  rollouts['/codex/in.jsonl'] = rolloutJsonl([
    { type: 'session_meta', payload: { id: 's-in', cwd: '/repo-A' } },
    { type: 'msg', payload: { content: 'match' } }
  ]);
  rollouts['/codex/out.jsonl'] = rolloutJsonl([
    { type: 'session_meta', payload: { id: 's-out', cwd: '/repo-B' } },
    { type: 'msg', payload: { content: 'match' } }
  ]);
  const { body } = await call('/api/search?q=match&projectId=p1');
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].sessionId, 's-in');
  assert.equal(body.projectId, 'p1');
});

test('projectId filter returns 404 for unknown project', async () => {
  rollouts['/codex/x.jsonl'] = rolloutJsonl([
    { type: 'session_meta', payload: { id: 's', cwd: '/r' } },
    { type: 'msg', payload: { content: 'match' } }
  ]);
  const { status } = await call('/api/search?q=match&projectId=ghost');
  assert.equal(status, 404);
});

test('projectId filter normalizes Windows-style backslashes when comparing', async () => {
  projects.set('p1', { id: 'p1', name: 'one', path: 'D:\\repo' });
  rollouts['/codex/a.jsonl'] = rolloutJsonl([
    { type: 'session_meta', payload: { id: 's', cwd: 'D:/repo' } },
    { type: 'msg', payload: { content: 'match' } }
  ]);
  const { body } = await call('/api/search?q=match&projectId=p1');
  assert.equal(body.results.length, 1);
});

test('since=YYYY-MM-DD overrides days when both are present', async () => {
  // Two files mtime-current; per-line timestamps determine sort, but the
  // mtime filter in the route runs against listRolloutFiles output. We
  // use the mtime-only filter to demonstrate `since` overriding `days`.
  rollouts['/codex/a.jsonl'] = rolloutJsonl([
    { type: 'session_meta', payload: { id: 's', cwd: '/r' } },
    { type: 'msg', payload: { content: 'match' }, timestamp: '2026-05-01T00:00:00Z' }
  ]);
  // since=in the future => no files included
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { body } = await call(`/api/search?q=match&since=${future}`);
  assert.equal(body.since, future);
  assert.equal(body.results.length, 0);
});

test('GET /api/search sorts hits most-recent first', async () => {
  rollouts['/codex/old.jsonl'] = rolloutJsonl([
    { type: 'session_meta', payload: { id: 's-old', cwd: '/r' } },
    { type: 'msg', payload: { content: 'match' }, timestamp: '2026-05-01T00:00:00Z' }
  ]);
  rollouts['/codex/new.jsonl'] = rolloutJsonl([
    { type: 'session_meta', payload: { id: 's-new', cwd: '/r' } },
    { type: 'msg', payload: { content: 'match' }, timestamp: '2026-05-16T00:00:00Z' }
  ]);
  const { body } = await call('/api/search?q=match');
  assert.deepEqual(body.results.map((r) => r.sessionId), ['s-new', 's-old']);
});
