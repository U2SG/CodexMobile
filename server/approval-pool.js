// Shared approval pool — a single map of in-flight prompts waiting on the
// user. Both the Codex app-server runner and the Claude PreToolUse hook
// register entries here; the WebSocket handler in server/index.js resolves
// them by `requestId` regardless of who registered.
//
// An entry is owned by whichever runner/hook created it. Owners supply two
// callbacks at register time:
//
//   shapeDecision(uiDecision, requestParams)  — converts the four-button UI
//     payload ({decision: 'approved'|'approved_for_session'|'denied'|'abort',
//     permissions?, answers?, elicitationResponse?}) into the wire-shape the
//     underlying protocol expects. Returned value is what the owner's
//     resolve() promise yields.
//
//   timedOutResponse()  — value to resolve with when the timeout fires or
//     the entry is force-resolved during teardown.
//
// Why not bake those into the pool itself? Because the Codex-vs-Claude
// decision encodings are wildly different (CommandExecutionApprovalDecision
// vs PreToolUse hookSpecificOutput), and the pool doesn't need to know.

import crypto from 'node:crypto';

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

const pendingApprovals = new Map();

// Per-process shared secret used to gate the Claude PreToolUse hook's HTTP
// callback. Lives here (rather than in the route module) so the runner can
// read it without taking a dependency on the route side-effect that
// registers the endpoint — the runner just needs to know the value to set
// CODEXMOBILE_HOOK_SECRET on the child Claude process; the route reads the
// same getter at request time.
let cachedClaudeHookSecret = null;
export function getClaudeHookSecret() {
  if (!cachedClaudeHookSecret) cachedClaudeHookSecret = crypto.randomBytes(32).toString('hex');
  return cachedClaudeHookSecret;
}

export function registerApproval({
  turnId,
  sessionId,
  method,
  kind,
  requestParams,
  signal = null,
  shapeDecision,
  timedOutResponse,
  abortResponse,
  timeoutMs = APPROVAL_TIMEOUT_MS,
  broadcast,
  broadcastExtra = {}
}) {
  if (typeof shapeDecision !== 'function') {
    throw new Error('registerApproval requires shapeDecision callback');
  }
  if (typeof timedOutResponse !== 'function') {
    throw new Error('registerApproval requires timedOutResponse callback');
  }
  const requestId = crypto.randomUUID();
  const promise = new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      pendingApprovals.delete(requestId);
      clearTimeout(timer);
      cleanupAbort?.();
      resolve(value);
    };
    const timer = setTimeout(() => settle(timedOutResponse()), timeoutMs);
    let cleanupAbort = null;
    if (signal) {
      const onAbort = () => settle((abortResponse || timedOutResponse)());
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        cleanupAbort = () => signal.removeEventListener('abort', onAbort);
      }
    }
    pendingApprovals.set(requestId, {
      requestId,
      turnId,
      sessionId,
      method,
      kind,
      requestParams,
      shapeDecision,
      timedOutResponse,
      settle
    });
  });

  if (typeof broadcast === 'function') {
    broadcast({
      type: 'approval-request',
      sessionId,
      turnId,
      requestId,
      kind,
      method,
      params: requestParams,
      ...broadcastExtra
    });
  }
  return { requestId, promise };
}

export function resolveApproval(requestId, uiDecision) {
  const entry = pendingApprovals.get(requestId);
  if (!entry) return false;
  const shaped = entry.shapeDecision(uiDecision || {}, entry.requestParams);
  entry.settle(shaped);
  return true;
}

// Force-resolve every approval that belongs to a given turn. Used during
// turn shutdown so the upstream (codex app-server, Claude hook) doesn't
// hang waiting for a response the user is no longer in a position to give.
export function dropApprovalsForTurn(turnId) {
  for (const [, entry] of pendingApprovals.entries()) {
    if (entry.turnId === turnId) {
      entry.settle(entry.timedOutResponse());
    }
  }
}

export function listPendingApprovals(filterTurnId = null) {
  const out = [];
  for (const [, entry] of pendingApprovals.entries()) {
    if (filterTurnId && entry.turnId !== filterTurnId) continue;
    out.push({
      requestId: entry.requestId,
      turnId: entry.turnId,
      sessionId: entry.sessionId,
      kind: entry.kind,
      method: entry.method,
      params: entry.requestParams
    });
  }
  return out;
}
