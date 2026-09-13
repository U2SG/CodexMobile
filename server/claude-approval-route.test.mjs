// End-to-end-ish test for the Claude PreToolUse hook → server endpoint.
// We don't actually spawn `claude` — we just exercise the HTTP contract
// the hook script depends on: POST to /api/internal/claude-approval with
// the right secret, await the long-poll, observe both the approval-request
// broadcast and the shaped decision in the response.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createClaudeApprovalRoute, getClaudeHookSecret } from './claude-approval-route.js';
import { resolveApproval } from './approval-pool.js';

async function bootServer() {
  const broadcasts = [];
  const route = createClaudeApprovalRoute({ broadcast: (frame) => broadcasts.push(frame) });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const handled = await route.preAuthHandle(req, res, {
      method: req.method,
      pathname: url.pathname
    });
    if (!handled) {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, broadcasts, port: server.address().port };
}

async function postHook(port, body, { secret = getClaudeHookSecret() } = {}) {
  return fetch(`http://127.0.0.1:${port}/api/internal/claude-approval`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Claude-Hook-Secret': secret
    },
    body: JSON.stringify(body)
  });
}

test('approval round-trip: hook POST → broadcast → resolveApproval → shaped JSON back', async () => {
  const { server, broadcasts, port } = await bootServer();
  try {
    const pendingResponse = postHook(port, {
      turnId: 'turn-abc',
      sessionId: 'sess-xyz',
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
      cwd: '/proj'
    });
    // Give the route a tick to register the approval before resolving.
    for (let i = 0; i < 20 && broadcasts.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(broadcasts.length, 1, 'one approval-request broadcast');
    const frame = broadcasts[0];
    assert.equal(frame.type, 'approval-request');
    assert.equal(frame.kind, 'claudeAction');
    assert.equal(frame.method, 'claude/PreToolUse');
    assert.equal(frame.params.toolName, 'Bash');

    assert.equal(resolveApproval(frame.requestId, { decision: 'approved' }), true);

    const res = await pendingResponse;
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.permissionDecision, 'allow');
  } finally {
    server.close();
  }
});

test('denied decision shapes to PreToolUse "deny" + reason', async () => {
  const { server, broadcasts, port } = await bootServer();
  try {
    const pending = postHook(port, {
      turnId: 'turn-deny',
      sessionId: '',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /' }
    });
    for (let i = 0; i < 20 && broadcasts.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const requestId = broadcasts[0].requestId;
    resolveApproval(requestId, { decision: 'denied' });
    const payload = await (await pending).json();
    assert.equal(payload.permissionDecision, 'deny');
    assert.match(payload.permissionDecisionReason, /拒绝/);
  } finally {
    server.close();
  }
});

test('AskUserQuestion: broadcasts claudeQuestion kind, answers shape to allow+updatedInput', async () => {
  const { server, broadcasts, port } = await bootServer();
  try {
    const questions = [{
      question: '偏好哪种主题配色？',
      header: '配色',
      multiSelect: false,
      options: [{ label: '暖色', description: '红橙调' }, { label: '冷色', description: '蓝青调' }]
    }];
    const pending = postHook(port, {
      turnId: 'turn-q',
      sessionId: 'sess-q',
      toolName: 'AskUserQuestion',
      toolInput: { questions }
    });
    for (let i = 0; i < 20 && broadcasts.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const frame = broadcasts[0];
    assert.equal(frame.kind, 'claudeQuestion');
    assert.equal(frame.params.toolName, 'AskUserQuestion');
    assert.deepEqual(frame.params.toolInput.questions, questions);

    assert.equal(resolveApproval(frame.requestId, {
      decision: 'approved',
      answers: { '偏好哪种主题配色？': '暖色' }
    }), true);

    const payload = await (await pending).json();
    assert.equal(payload.permissionDecision, 'allow');
    assert.deepEqual(payload.updatedInput.questions, questions);
    assert.deepEqual(payload.updatedInput.answers, { '偏好哪种主题配色？': '暖色' });
  } finally {
    server.close();
  }
});

test('AskUserQuestion: cancel (denied) shapes to deny, no updatedInput', async () => {
  const { server, broadcasts, port } = await bootServer();
  try {
    const pending = postHook(port, {
      turnId: 'turn-qc',
      sessionId: '',
      toolName: 'AskUserQuestion',
      toolInput: { questions: [{ question: 'x?', options: [{ label: 'a' }] }] }
    });
    for (let i = 0; i < 20 && broadcasts.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    resolveApproval(broadcasts[0].requestId, { decision: 'denied' });
    const payload = await (await pending).json();
    assert.equal(payload.permissionDecision, 'deny');
    assert.equal(payload.updatedInput, undefined);
  } finally {
    server.close();
  }
});

test('bypassPermissions: action tools auto-allow without a broadcast', async () => {
  const { server, broadcasts, port } = await bootServer();
  try {
    const res = await postHook(port, {
      turnId: 'turn-bypass',
      sessionId: 'sess-bypass',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf node_modules' },
      permissionMode: 'bypassPermissions'
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.permissionDecision, 'allow');
    // No prompt should ever reach the PWA for action tools under full access.
    assert.equal(broadcasts.length, 0, 'no approval-request broadcast');
  } finally {
    server.close();
  }
});

test('bypassPermissions: AskUserQuestion still surfaces as a prompt', async () => {
  const { server, broadcasts, port } = await bootServer();
  try {
    const pending = postHook(port, {
      turnId: 'turn-bypass-q',
      sessionId: 'sess-bypass-q',
      toolName: 'AskUserQuestion',
      toolInput: { questions: [{ question: 'x?', options: [{ label: 'a' }] }] },
      permissionMode: 'bypassPermissions'
    });
    for (let i = 0; i < 20 && broadcasts.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(broadcasts.length, 1, 'AskUserQuestion is exempt from auto-allow');
    assert.equal(broadcasts[0].kind, 'claudeQuestion');
    resolveApproval(broadcasts[0].requestId, {
      decision: 'approved',
      answers: { 'x?': 'a' }
    });
    const payload = await (await pending).json();
    assert.equal(payload.permissionDecision, 'allow');
  } finally {
    server.close();
  }
});

test('missing or wrong secret yields 401', async () => {
  const { server, port } = await bootServer();
  try {
    const noHeader = await fetch(`http://127.0.0.1:${port}/api/internal/claude-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: 't' })
    });
    assert.equal(noHeader.status, 401);
    const wrong = await postHook(port, { turnId: 't' }, { secret: 'nope' });
    assert.equal(wrong.status, 401);
  } finally {
    server.close();
  }
});

test('non-POST method yields 405', async () => {
  const { server, port } = await bootServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/internal/claude-approval`, {
      method: 'GET',
      headers: { 'X-Claude-Hook-Secret': getClaudeHookSecret() }
    });
    assert.equal(res.status, 405);
  } finally {
    server.close();
  }
});

test('missing turnId yields 400', async () => {
  const { server, port } = await bootServer();
  try {
    const res = await postHook(port, { sessionId: 's' });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
