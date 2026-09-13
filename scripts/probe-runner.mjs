#!/usr/bin/env node
// End-to-end probe: drive runCodexTurnViaAppServer via the runCodexTurn entry
// (so the env-gated dispatch is exercised), capture every emit() frame, and
// auto-approve any approval-request frames after 100ms.
//
// Run with:
//   CODEXMOBILE_CODEX_USE_APP_SERVER=1 \
//   CODEX_BINARY=...\codex.exe \
//     node scripts/probe-runner.mjs "ls 当前目录"

import { runCodexTurn } from '../server/codex-runner.js';
import { resolveCodexApproval } from '../server/codex-app-server-runner.js';

const PROMPT = process.argv.slice(2).join(' ') || '请用一句话回复，不要执行任何命令。';
const AUTO_DECISION = process.env.PROBE_DECISION || 'approved';

const emitted = [];
const seen = new Set();

function emit(frame) {
  emitted.push(frame);
  const type = frame.type;
  if (!seen.has(type)) {
    seen.add(type);
    process.stdout.write(`\n[first ${type}] `);
  }
  if (type === 'assistant-update') {
    process.stdout.write(frame.content?.slice(-80) || '');
  } else if (type === 'approval-request') {
    process.stdout.write(`\n[probe] approval-request kind=${frame.kind} method=${frame.method}\n`);
    process.stdout.write(`        reason=${frame.params?.reason || ''}\n`);
    process.stdout.write(`        command=${frame.params?.command || ''}\n`);
    setTimeout(() => {
      console.log(`[probe] auto-replying ${AUTO_DECISION}`);
      const ok = resolveCodexApproval(frame.requestId, { decision: AUTO_DECISION });
      if (!ok) console.warn('[probe] resolveCodexApproval returned false');
    }, 200);
  } else if (type === 'status-update') {
    process.stdout.write(`(${frame.kind}/${frame.status}) `);
  } else if (type === 'chat-complete' || type === 'chat-error' || type === 'chat-aborted') {
    console.log(`\n[probe] terminal ${type}: ${frame.error || frame.completionStatus || ''}`);
  }
}

try {
  const finalSessionId = await runCodexTurn({
    sessionId: null,
    draftSessionId: null,
    projectPath: process.cwd(),
    message: PROMPT,
    model: null,
    reasoningEffort: null,
    permissionMode: 'default',
    selectedSkills: [],
    turnId: null
  }, emit);
  console.log(`\n[probe] finalSessionId=${finalSessionId}`);
  const types = new Set(emitted.map((f) => f.type));
  console.log(`[probe] emitted types: ${[...types].join(', ')}`);
  const hasComplete = types.has('chat-complete');
  process.exit(hasComplete ? 0 : 1);
} catch (error) {
  console.error('[probe] threw:', error.message);
  process.exit(1);
}
