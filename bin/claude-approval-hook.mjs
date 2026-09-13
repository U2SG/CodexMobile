#!/usr/bin/env node
// Claude PreToolUse hook → CodexMobile server.
//
// Claude Code spawns this script before every tool invocation when the
// session's settings register it under hooks.PreToolUse. It receives the
// tool call info as JSON on stdin and is expected to write a hook output
// JSON to stdout describing the permission decision.
//
// We don't decide here — we forward the prompt to the CodexMobile server,
// which surfaces it as an approval-request frame on the chat WebSocket and
// blocks until the user (the PWA) responds. The server then returns the
// decision via HTTP and we transcribe it into Claude's hook output shape.
//
// stdin (from Claude):
//   { session_id, transcript_path, cwd, permission_mode, hook_event_name,
//     tool_name, tool_input }
//
// stdout (to Claude):
//   { hookSpecificOutput: { hookEventName: "PreToolUse",
//                           permissionDecision: "allow"|"deny"|"ask",
//                           permissionDecisionReason: "..." } }
//
// Env vars (set by runClaudeTurn for CodexMobile's own headless spawns):
//   CODEXMOBILE_HOOK_URL    — POST endpoint, e.g. http://127.0.0.1:3333/api/internal/claude-approval
//   CODEXMOBILE_HOOK_SECRET — per-process shared secret
//   CODEXMOBILE_TURN_ID     — turn id that the run is keyed under
//
// Remote-terminal mode (opt-in via the `cmr` / start-claude-remote launcher):
//   CODEXMOBILE_REMOTE=1    — this is a user-driven interactive `claude` that
//                             wants its tool calls answered on the phone. The
//                             hook URL+secret are NOT in env (the launcher
//                             doesn't know the per-process secret); instead we
//                             read them from the endpoint file the claude
//                             server writes at boot. Failures here fail-CLOSED
//                             (emit `ask` → claude's normal local prompt/TUI),
//                             never fail-open, so an unreachable server can't
//                             silently auto-allow a command in the user's shell.
//   CODEXMOBILE_HOOK_ENDPOINT_FILE — test override for the endpoint file path.

import { Buffer } from 'node:buffer';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

function emit(decision, reason, extra = {}) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason || '',
      // For AskUserQuestion the server returns `updatedInput.answers` — the
      // only headless-supported way to feed the user's choice back as the
      // tool result. Forward it verbatim when present; absent for all other
      // tools, where it stays undefined and is dropped from the JSON.
      ...(extra.updatedInput ? { updatedInput: extra.updatedInput } : {})
    }
  }));
  // Fail-open: if anything below throws, we already printed `allow` and the
  // turn keeps going. Better than orphaning Claude on a partial decision.
  process.exit(0);
}

function emitAllow(reason) { emit('allow', reason); }
function emitDeny(reason) { emit('deny', reason); }
function emitAsk(reason) { emit('ask', reason); }

// The claude server writes { url, secret } here at boot (claude mode only).
// Located relative to this script (bin/..), so it resolves no matter what cwd
// Claude spawns the hook in.
async function readRemoteEndpoint() {
  const file = process.env.CODEXMOBILE_HOOK_ENDPOINT_FILE
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.codexmobile', 'state', 'hook-endpoint.json');
  try {
    const json = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (json?.url && json?.secret) return json;
  } catch {
    // missing/unreadable — server not running; caller fails closed
  }
  return null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (error) {
    return { _parseError: error.message, _raw: buf.toString('utf8').slice(0, 400) };
  }
}

async function main() {
  const input = await readStdin();
  if (input?._parseError) {
    // Fail-closed in remote terminals (TTY to fall back to), fail-open for
    // headless CodexMobile spawns (no TTY).
    const remoteIntent = process.env.CODEXMOBILE_REMOTE
      && !(process.env.CODEXMOBILE_HOOK_URL && process.env.CODEXMOBILE_HOOK_SECRET);
    if (remoteIntent) emitAsk(`hook stdin JSON parse failed: ${input._parseError}; 转本地确认`);
    else emitAllow(`hook stdin JSON parse failed: ${input._parseError}`);
    return;
  }

  let hookUrl = process.env.CODEXMOBILE_HOOK_URL || '';
  let hookSecret = process.env.CODEXMOBILE_HOOK_SECRET || '';
  let turnId = process.env.CODEXMOBILE_TURN_ID || '';
  // `remote` flips the failure policy: an interactive terminal has a TTY to
  // fall back to, so we fail closed (ask); a headless CodexMobile spawn does
  // not, so it keeps the historical fail-open (allow).
  let remote = false;

  if (!hookUrl || !hookSecret) {
    if (process.env.CODEXMOBILE_REMOTE) {
      remote = true;
      const endpoint = await readRemoteEndpoint();
      if (!endpoint) {
        emitAsk('CodexMobile 服务未运行，转本地确认');
        return;
      }
      hookUrl = endpoint.url;
      hookSecret = endpoint.secret;
      turnId = `remote-${input.session_id || 'unknown'}`;
    } else {
      // Mis-configured CodexMobile spawn — let the turn proceed unblocked
      // rather than wedging a headless run that has no TTY to prompt on.
      emitAllow('CodexMobile hook URL/secret not set; defaulting to allow');
      return;
    }
  }

  const body = JSON.stringify({
    turnId,
    sessionId: input.session_id || '',
    cwd: input.cwd || '',
    permissionMode: input.permission_mode || '',
    toolName: input.tool_name || '',
    toolInput: input.tool_input || {}
  });

  // The server long-polls — only abort after ~6 min so the 5 min approval
  // window has a chance to land before we give up.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6 * 60 * 1000);
  try {
    const response = await fetch(hookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Claude-Hook-Secret': hookSecret
      },
      body,
      signal: ac.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      const msg = `approval endpoint returned ${response.status}`;
      if (remote) emitAsk(`${msg}; 转本地确认`);
      else emitAllow(`${msg}; defaulting to allow`);
      return;
    }
    const payload = await response.json();
    const decision = (payload?.permissionDecision || 'allow').toLowerCase();
    const reason = payload?.reason || payload?.permissionDecisionReason || '';
    if (decision === 'deny') emitDeny(reason || '用户在 CodexMobile 中拒绝');
    else if (decision === 'ask') emit('ask', reason);
    else emit('allow', reason, { updatedInput: payload?.updatedInput });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === 'AbortError') {
      if (remote) emitAsk('CodexMobile 审批超时，转本地确认');
      else emitDeny('CodexMobile 审批超时（6 分钟无回应）');
    } else if (remote) {
      emitAsk(`hook 请求失败（${error.message}），转本地确认`);
    } else {
      emitAllow(`hook request failed: ${error.message}; defaulting to allow`);
    }
  }
}

main().catch((err) => {
  // Last-resort fail-open so the turn doesn't deadlock.
  emitAllow(`hook crashed: ${err.message}`);
});
