import { strict as assert } from 'node:assert';
import http from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import {
  buildCompactPrompt,
  createChatRoutes,
  extractClaudeTurns
} from './chat-routes.js';

let server;
let baseUrl;
let chatServiceMock;
let calls;

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
  calls = { sendChat: [], abortChat: [], steerQueued: [], steerIpc: [], turnLookup: [], listQueue: [] };
  chatServiceMock = {
    listQueue: (args) => { calls.listQueue.push(args); return { drafts: [] }; },
    removeQueuedDraft: (body) => (body.id === 'd-1' ? { id: 'd-1' } : null),
    restoreQueuedDraft: (body) => (body.id === 'd-1' ? { id: 'd-1', text: 'restored' } : null),
    steerQueuedDraft: async (body) => {
      calls.steerQueued.push(body);
      return { ok: true };
    },
    sendChat: async (body, opts) => {
      calls.sendChat.push({ body, opts });
      return { accepted: true, turnId: 't-1' };
    },
    abortChat: async (body) => {
      calls.abortChat.push(body);
      return true;
    },
    getTurn: (id) => { calls.turnLookup.push(id); return { id, status: 'running' }; }
  };
  const routes = createChatRoutes({
    chatService: chatServiceMock,
    steerDesktopFollowerTurn: async (sessionId, payload, opts) => {
      calls.steerIpc.push({ sessionId, payload, opts });
      return { delivered: true };
    },
    findClaudeSessionJsonlPath: async () => null, // not exercising compact in HTTP tests
    getAllActiveRuns: () => [],
    broadcast: () => {},
    remoteAddress: () => '127.0.0.1'
  });
  ({ srv: server, baseUrl } = await startTestServer(routes));
});

afterEach(() => new Promise((resolve) => server.close(resolve)));

test('buildCompactPrompt embeds the conversation and truncates to the limit', () => {
  const short = buildCompactPrompt('hi');
  assert.ok(short.includes('Conversation:\n\nhi'));
  const huge = 'x'.repeat(60_000);
  const prompt = buildCompactPrompt(huge);
  // Should be truncated to under 41000 + prefix
  assert.ok(prompt.length < 41_500);
  assert.ok(prompt.includes('x'.repeat(100)));
});

test('extractClaudeTurns picks user + assistant messages and tracks lastUuid', () => {
  const lines = [
    JSON.stringify({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'hello' } }),
    JSON.stringify({ uuid: 'u2', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi back' }] } }),
    'malformed{',
    JSON.stringify({ uuid: 'u3', type: 'user', isMeta: true, message: { role: 'user', content: 'should-skip' } }),
    JSON.stringify({ uuid: 'u4', type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'second user' }] } })
  ];
  const { turns, lastUuid } = extractClaudeTurns(lines.join('\n'));
  assert.deepEqual(turns, [
    'Human: hello',
    'Assistant: hi back',
    'Human: second user'
  ]);
  assert.equal(lastUuid, 'u4');
});

test('GET /api/chat/turns/:id looks up the turn via chatService', async () => {
  const res = await fetch(`${baseUrl}/api/chat/turns/turn-abc`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.turn.id, 'turn-abc');
  assert.deepEqual(calls.turnLookup, ['turn-abc']);
});

test('GET /api/chat/queue forwards sessionId + draftSessionId', async () => {
  const res = await fetch(`${baseUrl}/api/chat/queue?sessionId=s1&draftSessionId=d1`);
  assert.equal(res.status, 200);
  assert.deepEqual(calls.listQueue, [{ sessionId: 's1', draftSessionId: 'd1' }]);
});

test('DELETE /api/chat/queue returns 404 when removal fails', async () => {
  const res = await fetch(`${baseUrl}/api/chat/queue`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'nope' })
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.success, false);
});

test('POST /api/chat/queue/restore returns the restored draft', async () => {
  const res = await fetch(`${baseUrl}/api/chat/queue/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'd-1' })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.draft.text, 'restored');
});

test('POST /api/chat/send returns 202 + chatService result', async () => {
  const res = await fetch(`${baseUrl}/api/chat/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hi', projectId: 'p1' })
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.accepted, true);
  assert.equal(calls.sendChat[0].body.message, 'hi');
});

test('POST /api/chat/send surfaces statusCode from chatService errors', async () => {
  chatServiceMock.sendChat = async () => {
    const err = new Error('project not found');
    err.statusCode = 404;
    throw err;
  };
  const res = await fetch(`${baseUrl}/api/chat/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hi' })
  });
  assert.equal(res.status, 404);
});

test('POST /api/chat/steer rejects empty sessionId and draft sessions', async () => {
  const r1 = await fetch(`${baseUrl}/api/chat/steer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: 'x' })
  });
  assert.equal(r1.status, 400);

  const r2 = await fetch(`${baseUrl}/api/chat/steer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'draft-abc', input: 'x' })
  });
  assert.equal(r2.status, 400);
});

test('POST /api/chat/steer forwards to desktop follower on valid input', async () => {
  const res = await fetch(`${baseUrl}/api/chat/steer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', input: 'help' })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(calls.steerIpc[0].sessionId, 's1');
  assert.equal(calls.steerIpc[0].payload.input, 'help');
});

test('POST /api/chat/compact 400s for codex- or draft- session ids', async () => {
  const r1 = await fetch(`${baseUrl}/api/chat/compact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'codex-abc' })
  });
  assert.equal(r1.status, 400);

  const r2 = await fetch(`${baseUrl}/api/chat/compact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'draft-abc' })
  });
  assert.equal(r2.status, 400);
});

test('POST /api/chat/compact 404s when session file is not found on disk', async () => {
  // findClaudeSessionJsonlPath returns null in the mock
  const res = await fetch(`${baseUrl}/api/chat/compact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'real-session-id', projectId: 'p1' })
  });
  assert.equal(res.status, 404);
});

test('returns false (passthrough) for unrelated paths', async () => {
  const res = await fetch(`${baseUrl}/api/other`);
  assert.equal(res.status, 404);
});
