// Gating tests for bin/claude-approval-hook.mjs — the script Claude spawns as
// a PreToolUse hook. We spawn it for real, feed stdin, and inspect the
// hookSpecificOutput it writes. A throwaway HTTP responder stands in for the
// CodexMobile server. The endpoint-file path is overridden via
// CODEXMOBILE_HOOK_ENDPOINT_FILE so we never touch the real state file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'claude-approval-hook.mjs');
const CODEX_VARS = ['CODEXMOBILE_HOOK_URL', 'CODEXMOBILE_HOOK_SECRET', 'CODEXMOBILE_TURN_ID', 'CODEXMOBILE_REMOTE', 'CODEXMOBILE_HOOK_ENDPOINT_FILE'];

function runHook({ env = {}, stdin = {} } = {}) {
  const childEnv = { ...process.env };
  for (const v of CODEX_VARS) delete childEnv[v];
  Object.assign(childEnv, env);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.on('close', () => {
      let parsed = null;
      try { parsed = JSON.parse(out).hookSpecificOutput; } catch {}
      resolve({ raw: out, hso: parsed });
    });
    child.stdin.end(JSON.stringify(stdin));
  });
}

async function withResponder(handler, fn) {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    hits.push({ secret: req.headers['x-claude-hook-secret'], body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/api/internal/claude-approval`, hits);
  } finally {
    server.close();
  }
}

test('no CodexMobile env and not remote → fail-open allow (unchanged headless behavior)', async () => {
  const { hso } = await runHook({ stdin: { tool_name: 'Bash', tool_input: { command: 'ls' } } });
  assert.equal(hso.permissionDecision, 'allow');
});

test('remote mode + endpoint file → POSTs with file secret, transcribes allow + updatedInput', async () => {
  const questions = [{ question: '配色?', options: [{ label: '暖色' }], multiSelect: false }];
  await withResponder((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ permissionDecision: 'allow', updatedInput: { questions, answers: { '配色?': '暖色' } } }));
  }, async (url, hits) => {
    const epFile = path.join(os.tmpdir(), `cm-ep-${process.pid}-${Date.now()}.json`);
    await fs.writeFile(epFile, JSON.stringify({ url, secret: 'file-secret-xyz' }), 'utf8');
    try {
      const { hso } = await runHook({
        env: { CODEXMOBILE_REMOTE: '1', CODEXMOBILE_HOOK_ENDPOINT_FILE: epFile },
        stdin: { session_id: 'sess-1', tool_name: 'AskUserQuestion', tool_input: { questions } }
      });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].secret, 'file-secret-xyz', 'uses secret from the endpoint file');
      assert.equal(hits[0].body.turnId, 'remote-sess-1', 'synthesizes a per-session turnId');
      assert.equal(hso.permissionDecision, 'allow');
      assert.deepEqual(hso.updatedInput.answers, { '配色?': '暖色' });
    } finally {
      await fs.unlink(epFile).catch(() => {});
    }
  });
});

test('remote mode + missing endpoint file → fail-closed ask, no POST', async () => {
  const { hso } = await runHook({
    env: { CODEXMOBILE_REMOTE: '1', CODEXMOBILE_HOOK_ENDPOINT_FILE: path.join(os.tmpdir(), 'cm-nonexistent-endpoint.json') },
    stdin: { session_id: 's', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }
  });
  assert.equal(hso.permissionDecision, 'ask');
});

test('remote mode + server returns non-OK → fail-closed ask', async () => {
  await withResponder((req, res) => { res.writeHead(500).end('boom'); }, async (url) => {
    const epFile = path.join(os.tmpdir(), `cm-ep-err-${process.pid}-${Date.now()}.json`);
    await fs.writeFile(epFile, JSON.stringify({ url, secret: 's' }), 'utf8');
    try {
      const { hso } = await runHook({
        env: { CODEXMOBILE_REMOTE: '1', CODEXMOBILE_HOOK_ENDPOINT_FILE: epFile },
        stdin: { session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } }
      });
      assert.equal(hso.permissionDecision, 'ask');
    } finally {
      await fs.unlink(epFile).catch(() => {});
    }
  });
});

test('CodexMobile env present → routes to env URL with env secret (unchanged)', async () => {
  await withResponder((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: 'no' }));
  }, async (url, hits) => {
    const { hso } = await runHook({
      env: { CODEXMOBILE_HOOK_URL: url, CODEXMOBILE_HOOK_SECRET: 'env-secret', CODEXMOBILE_TURN_ID: 'turn-9' },
      stdin: { session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } }
    });
    assert.equal(hits[0].secret, 'env-secret');
    assert.equal(hits[0].body.turnId, 'turn-9');
    assert.equal(hso.permissionDecision, 'deny');
  });
});
