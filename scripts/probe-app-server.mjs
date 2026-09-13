#!/usr/bin/env node
// Probe: spawn `codex app-server --listen stdio://`, initialize, start a
// thread, send a turn that needs shell execution, and confirm the approval
// roundtrip works. Run with:
//
//   node scripts/probe-app-server.mjs "ls -la"
//
// Auto-approves anything the server asks. Prints every notification and
// server request to stdout. Exits 0 when turn/completed arrives; exits 1 on
// error, timeout, or unhandled rejection.

import { CodexAppServerClient } from '../server/codex-app-server.js';

const PROMPT = process.argv.slice(2).join(' ') ||
  '请用一个 shell 命令列出当前目录的内容，再用一句话总结。';
const TIMEOUT_MS = 120_000;

const headlessTransport = {
  mode: 'headless-local',
  strict: false,
  sockPath: null,
  connected: true,
  reason: 'probe'
};

const seen = { threadStarted: false, turnStarted: false, turnCompleted: false };
let threadId = null;
let turnId = null;
let resolveDone;
let rejectDone;
const done = new Promise((resolve, reject) => {
  resolveDone = resolve;
  rejectDone = reject;
});

function log(label, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const trimmed = text.length > 600 ? `${text.slice(0, 600)}…` : text;
  console.log(`[probe] ${label} ${trimmed}`);
}

const client = new CodexAppServerClient({
  cwd: process.cwd(),
  clientInfo: { name: 'CodexMobileProbe', version: '0.0.1' },
  transport: headlessTransport,
  onNotification: (message) => {
    const method = message.method;
    if (method === 'thread/started') {
      seen.threadStarted = true;
      threadId = message.params?.thread?.id || threadId;
      log('notif', { method, threadId });
      return;
    }
    if (method === 'turn/started') {
      seen.turnStarted = true;
      turnId = message.params?.turn?.id || turnId;
      log('notif', { method, threadId: message.params?.threadId, turnId });
      return;
    }
    if (method === 'turn/completed') {
      seen.turnCompleted = true;
      const status = message.params?.turn?.status;
      log('notif', { method, status, turnId: message.params?.turn?.id });
      resolveDone({ status });
      return;
    }
    if (method === 'error') {
      log('notif-error', message.params);
      rejectDone(new Error(JSON.stringify(message.params?.error || message.params)));
      return;
    }
    // Stream events: keep them short.
    if (method === 'item/agentMessage/delta') {
      process.stdout.write(message.params?.delta || '');
      return;
    }
    if (
      method === 'item/started' ||
      method === 'item/completed' ||
      method === 'item/commandExecution/outputDelta' ||
      method === 'item/reasoning/textDelta'
    ) {
      log('notif', { method, itemId: message.params?.item?.id || message.params?.itemId });
      return;
    }
    log('notif', { method });
  },
  onServerRequest: (message) => {
    log('server-request', { id: message.id, method: message.method, params: message.params });
    switch (message.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'execCommandApproval':
      case 'applyPatchApproval':
        return { decision: 'approved' };
      case 'item/permissions/requestApproval':
        return { permissions: message.params?.permissions || {}, scope: 'turn' };
      case 'item/tool/requestUserInput':
        return { answers: {} };
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null };
      default:
        return null;
    }
  }
});

const timer = setTimeout(() => {
  rejectDone(new Error(`probe timed out after ${TIMEOUT_MS}ms; seen=${JSON.stringify(seen)}`));
}, TIMEOUT_MS);

try {
  log('boot', `prompt=${PROMPT}`);
  await client.initialize();
  log('initialized', '');
  const threadResp = await client.request('thread/start', {
    cwd: process.cwd(),
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write'
  }, { timeoutMs: 30_000 });
  threadId = threadResp?.thread?.id || threadId;
  log('thread/start', { threadId, model: threadResp?.model });

  const turnResp = await client.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: PROMPT, text_elements: [] }]
  }, { timeoutMs: 30_000 });
  turnId = turnResp?.turn?.id || turnId;
  log('turn/start', { turnId });

  const { status } = await done;
  log('result', { status, seen });
  clearTimeout(timer);
  client.close();
  process.exit(status === 'completed' ? 0 : 1);
} catch (error) {
  clearTimeout(timer);
  console.error('[probe] error:', error.message);
  client.close();
  process.exit(1);
}
