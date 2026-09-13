// Headless Codex turn runner that talks to `codex app-server --listen stdio://`
// directly, replacing the `@openai/codex-sdk` exec path. The SDK is one-way
// (it just spawns `codex exec --experimental-json` and reads JSONL), so it
// cannot relay approval prompts back to the user. The app-server protocol is
// bidirectional and exposes the full approval roundtrip — see
// `codex app-server generate-ts --out <DIR>` for the wire types.
//
// Enable by setting `CODEXMOBILE_CODEX_USE_APP_SERVER=1`. When off, the
// existing SDK path in codex-runner.js continues to run.
//
// Wire events emitted to chat-service via `emit(...)` mirror the SDK runner's
// shape (`thread-started`, `chat-started`, `assistant-update`,
// `activity-update`, `status-update`, `chat-complete`, `chat-error`,
// `chat-aborted`) plus one new frame:
//
//   { type: 'approval-request',
//     sessionId, turnId, requestId,
//     kind: 'execCommand'|'fileChange'|'permissions'|'toolInput'|...,
//     method, params }
//
// Once the browser/PWA replies, the WS handler calls `resolveCodexApproval(
// requestId, decision)` and the app-server resumes.

import crypto from 'node:crypto';
import { CodexAppServerClient, defaultServerRequestResult } from './codex-app-server.js';
import { emitCodexEvent, humanizeCodexFailure, getActiveRunRegistry } from './codex-runner.js';
import {
  registerApproval,
  resolveApproval,
  dropApprovalsForTurn,
  listPendingApprovals as poolListPendingApprovals
} from './approval-pool.js';

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'applyPatchApproval',
  'execCommandApproval'
]);

function approvalKind(method) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval':
      return 'execCommand';
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval':
      return 'fileChange';
    case 'item/permissions/requestApproval':
      return 'permissions';
    case 'item/tool/requestUserInput':
      return 'toolInput';
    case 'mcpServer/elicitation/request':
      return 'mcpElicitation';
    default:
      return 'unknown';
  }
}

// v2 approval methods (item/commandExecution/requestApproval,
// item/fileChange/requestApproval) use CommandExecutionApprovalDecision /
// FileChangeApprovalDecision — both encode their enum as
// 'accept' | 'acceptForSession' | 'decline' | 'cancel' + amendment variants.
// Legacy execCommandApproval / applyPatchApproval still use the older
// ReviewDecision shape ('approved' | 'approved_for_session' | 'denied' | ...).
function isV2ApprovalMethod(method) {
  return method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval';
}

function timedOutResponseFor(method) {
  switch (method) {
    case 'item/tool/requestUserInput':
      return { answers: {} };
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null };
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' };
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      // No "timed_out" variant on the v2 decisions — fall back to decline.
      return { decision: 'decline' };
    default:
      return { decision: 'timed_out' };
  }
}

function abortResponseFor(method) {
  switch (method) {
    case 'item/tool/requestUserInput':
      return { answers: {} };
    case 'mcpServer/elicitation/request':
      return { action: 'cancel', content: null, _meta: null };
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' };
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'cancel' };
    default:
      return { decision: 'abort' };
  }
}

// Map a UI decision payload to the on-wire ReviewDecision the app-server
// expects. The UI sends one of: 'approved' | 'approved_for_session' |
// 'denied' | 'abort'. Persistent-permission variants (network/execpolicy
// amendments) are echoed verbatim from the original request params when the
// UI sends `kind: 'approved_for_session'` and the request carried a proposed
// amendment.
function shapeReviewDecision(uiDecision, requestParams, method) {
  if (method === 'item/tool/requestUserInput') {
    return { answers: uiDecision?.answers || {} };
  }
  if (method === 'mcpServer/elicitation/request') {
    return uiDecision?.elicitationResponse || { action: 'decline', content: null, _meta: null };
  }
  if (method === 'item/permissions/requestApproval') {
    if (uiDecision?.decision === 'approved' || uiDecision?.decision === 'approved_for_session') {
      const scope = uiDecision.decision === 'approved_for_session' ? 'session' : 'turn';
      return { permissions: uiDecision.permissions || requestParams?.permissions || {}, scope };
    }
    return { permissions: {}, scope: 'turn' };
  }

  const decision = uiDecision?.decision || 'denied';

  if (isV2ApprovalMethod(method)) {
    // v2 enum: accept | acceptForSession | decline | cancel
    //          | { acceptWithExecpolicyAmendment: { execpolicy_amendment } }
    //          | { applyNetworkPolicyAmendment: { network_policy_amendment } }
    if (decision === 'approved') return { decision: 'accept' };
    if (decision === 'denied') return { decision: 'decline' };
    if (decision === 'abort') return { decision: 'cancel' };
    if (decision === 'approved_for_session') {
      // Prefer the network amendment when the request offered one (covers the
      // common "let me actually reach the internet" case). Fall back to exec
      // policy amendment, then to plain acceptForSession.
      if (Array.isArray(requestParams?.proposedNetworkPolicyAmendments) && requestParams.proposedNetworkPolicyAmendments[0]) {
        return { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: requestParams.proposedNetworkPolicyAmendments[0] } } };
      }
      if (requestParams?.proposedExecpolicyAmendment) {
        return { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: requestParams.proposedExecpolicyAmendment } } };
      }
      return { decision: 'acceptForSession' };
    }
    return { decision: 'decline' };
  }

  // Legacy ReviewDecision (used by execCommandApproval / applyPatchApproval).
  if (decision === 'approved_for_session') {
    if (requestParams?.proposedExecpolicyAmendment) {
      return { decision: { approved_execpolicy_amendment: { proposed_execpolicy_amendment: requestParams.proposedExecpolicyAmendment } } };
    }
    if (Array.isArray(requestParams?.proposedNetworkPolicyAmendments) && requestParams.proposedNetworkPolicyAmendments[0]) {
      return { decision: { network_policy_amendment: { network_policy_amendment: requestParams.proposedNetworkPolicyAmendments[0] } } };
    }
    return { decision: 'approved_for_session' };
  }
  return { decision };
}

// Convert an app-server ThreadItem (camelCase, current shape) to the
// SDK-style ThreadItem (snake_case, expected by emitCodexEvent). Only fields
// that emitCodexEvent reads are translated; the rest pass through.
function appServerItemToSdkItem(item) {
  if (!item || typeof item !== 'object') return item;
  switch (item.type) {
    case 'agentMessage':
      return { ...item, type: 'agent_message', text: item.text };
    case 'reasoning':
      return { ...item, type: 'reasoning', text: Array.isArray(item.summary) ? item.summary.join('\n') : (item.content?.join?.('\n') || '') };
    case 'commandExecution':
      return {
        ...item,
        type: 'command_execution',
        command: item.command,
        aggregated_output: item.aggregatedOutput || '',
        exit_code: item.exitCode,
        status: item.status
      };
    case 'fileChange':
      return {
        ...item,
        type: 'file_change',
        changes: Array.isArray(item.changes) ? item.changes : [],
        status: item.status
      };
    case 'mcpToolCall':
      return {
        ...item,
        type: 'mcp_tool_call',
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result,
        error: item.error,
        status: item.status
      };
    case 'webSearch':
      return { ...item, type: 'web_search', query: item.query };
    case 'todoList':
      return { ...item, type: 'todo_list', items: item.items || [] };
    case 'userMessage':
      return { ...item, type: 'user_message' };
    case 'dynamicToolCall':
      return {
        ...item,
        type: 'custom_tool_call',
        tool: item.tool,
        arguments: item.arguments,
        status: item.status
      };
    default:
      return item;
  }
}

// Translate an app-server notification message into an SDK-shaped event the
// existing emitCodexEvent helper already understands. Returns null when the
// notification has no SDK analogue and the caller should ignore it.
function notificationToSdkEvent(message) {
  const { method, params } = message;
  switch (method) {
    case 'thread/started':
      return { type: 'thread.started', thread_id: params?.thread?.id };
    case 'turn/started':
      return { type: 'turn.started' };
    case 'turn/completed':
      return {
        type: 'turn.completed',
        usage: params?.turn?.tokenUsage || params?.turn?.usage || null
      };
    case 'item/started':
      return { type: 'item.started', item: appServerItemToSdkItem(params?.item) };
    case 'item/completed':
      return { type: 'item.completed', item: appServerItemToSdkItem(params?.item) };
    case 'error':
      return { type: 'error', message: params?.error?.message || 'Codex app-server error' };
    default:
      return null;
  }
}

function mapPermissionToAppServer(permissionMode) {
  if (permissionMode === 'bypassPermissions') {
    return { sandbox: 'danger-full-access', approvalPolicy: 'never' };
  }
  if (permissionMode === 'acceptEdits') {
    return { sandbox: 'workspace-write', approvalPolicy: 'on-failure' };
  }
  return { sandbox: 'workspace-write', approvalPolicy: 'on-request' };
}

function normalizeReasoningEffort(value) {
  const v = String(value || '').trim();
  return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(v) ? v : null;
}

function buildUserInput(message, attachments = []) {
  const parts = [];
  if (message && typeof message === 'string') {
    parts.push({ type: 'text', text: message, text_elements: [] });
  } else if (Array.isArray(message)) {
    for (const piece of message) {
      if (typeof piece === 'string') {
        parts.push({ type: 'text', text: piece, text_elements: [] });
      } else if (piece?.text) {
        parts.push({ type: 'text', text: piece.text, text_elements: piece.text_elements || [] });
      } else if (piece?.path) {
        parts.push({ type: 'localImage', path: piece.path });
      }
    }
  }
  if (!parts.length) {
    parts.push({ type: 'text', text: '', text_elements: [] });
  }
  for (const att of attachments || []) {
    if (att?.path) {
      parts.push({ type: 'localImage', path: att.path });
    }
  }
  return parts;
}

// Re-export the pool resolver under the historical name so existing callers
// (server/index.js WS handler, tests) keep working. New code should import
// resolveApproval directly from approval-pool.js.
export function resolveCodexApproval(requestId, decision) {
  return resolveApproval(requestId, decision);
}

export function listPendingApprovals(filterTurnId = null) {
  return poolListPendingApprovals(filterTurnId);
}

export async function runCodexTurnViaAppServer(args, emit) {
  const {
    sessionId,
    draftSessionId,
    projectPath,
    message,
    model,
    reasoningEffort,
    permissionMode,
    attachments,
    turnId: providedTurnId
  } = args;

  const activeRuns = getActiveRunRegistry();
  const turnId = providedTurnId || crypto.randomUUID();
  const abortController = new AbortController();
  const state = { hadAssistantText: false, failed: false, usage: null };

  const { sandbox, approvalPolicy } = mapPermissionToAppServer(permissionMode);

  let currentSessionId = sessionId || null;
  let previousSessionId = draftSessionId || sessionId || null;
  let appServerThreadId = sessionId || null;
  let turnCompletedResolver;
  let turnCompletedRejecter;
  const turnCompleted = new Promise((resolve, reject) => {
    turnCompletedResolver = resolve;
    turnCompletedRejecter = reject;
  });

  const run = {
    process: null,
    abortController,
    turnId,
    sessionId: currentSessionId,
    previousSessionId,
    startedAt: new Date().toISOString(),
    status: 'running'
  };
  activeRuns.set(turnId, run);

  const client = new CodexAppServerClient({
    cwd: projectPath || process.cwd(),
    env: process.env,
    clientInfo: { name: 'CodexMobile', version: '0.1.0' },
    transport: { mode: 'headless-local', strict: false, sockPath: null, connected: true, reason: null },
    onNotification: (msg) => handleNotification(msg),
    onServerRequest: (msg) => handleServerRequest(msg)
  });

  function handleNotification(msg) {
    // Surface turn completion to the await below.
    if (msg.method === 'turn/completed') {
      state.usage = msg.params?.turn?.tokenUsage || msg.params?.turn?.usage || null;
      turnCompletedResolver({ status: msg.params?.turn?.status || 'completed' });
    }
    if (msg.method === 'error' && msg.params?.willRetry === false) {
      state.failed = true;
      const errMessage = humanizeCodexFailure(msg.params?.error?.message || 'Codex app-server error');
      turnCompletedRejecter(new Error(errMessage));
    }
    // Track thread id from thread/started so subsequent reasoning emits go to
    // the right session id.
    if (msg.method === 'thread/started') {
      const id = msg.params?.thread?.id;
      if (id) {
        if (id !== currentSessionId) {
          previousSessionId = currentSessionId || previousSessionId;
        }
        currentSessionId = id;
        run.sessionId = id;
        run.previousSessionId = previousSessionId;
        emit({
          type: 'thread-started',
          sessionId: id,
          previousSessionId,
          turnId,
          projectPath,
          startedAt: new Date().toISOString()
        });
      }
    }
    const sdkEvent = notificationToSdkEvent(msg);
    if (sdkEvent) {
      emitCodexEvent(sdkEvent, currentSessionId, turnId, emit, state);
    }
  }

  function handleServerRequest(msg) {
    if (!APPROVAL_METHODS.has(msg.method)) {
      // Non-approval methods (e.g. account/chatgptAuthTokens/refresh) get the
      // safe default; never block them on the user.
      return defaultServerRequestResult(msg);
    }
    const method = msg.method;
    const { promise } = registerApproval({
      turnId,
      sessionId: currentSessionId,
      method,
      kind: approvalKind(method),
      requestParams: msg.params,
      signal: abortController.signal,
      shapeDecision: (uiDecision, requestParams) => shapeReviewDecision(uiDecision, requestParams, method),
      timedOutResponse: () => timedOutResponseFor(method),
      abortResponse: () => abortResponseFor(method),
      broadcast: emit
    });
    return promise;
  }

  try {
    await client.initialize();

    if (appServerThreadId) {
      await client.request('thread/resume', {
        threadId: appServerThreadId,
        cwd: projectPath || null,
        approvalPolicy,
        sandbox,
        model: model || null,
        excludeTurns: true
      }, { timeoutMs: 30_000 });
      currentSessionId = appServerThreadId;
      run.sessionId = appServerThreadId;
    } else {
      const startResp = await client.request('thread/start', {
        cwd: projectPath || null,
        approvalPolicy,
        sandbox,
        model: model || null
      }, { timeoutMs: 30_000 });
      const newId = startResp?.thread?.id;
      if (newId) {
        currentSessionId = newId;
        run.sessionId = newId;
      }
    }

    emit({
      type: 'chat-started',
      sessionId: currentSessionId,
      previousSessionId,
      turnId,
      projectPath,
      startedAt: new Date().toISOString()
    });

    const input = buildUserInput(message, attachments);
    const effort = normalizeReasoningEffort(reasoningEffort);
    await client.request('turn/start', {
      threadId: currentSessionId,
      input,
      model: model || null,
      effort,
      approvalPolicy
      // Note: sandboxPolicy override is intentionally omitted — sandbox is
      // already set at thread/start, and the v2 SandboxPolicy shape differs
      // from the v1 SandboxMode that we currently track. Revisit when adding
      // workspace-write writable-roots support.
    }, { timeoutMs: 30_000 });

    // turn/start returns immediately after the model starts; the stream of
    // notifications drives the rest of the turn. Wait for turn/completed (or
    // an error notification) to resolve.
    const completion = await Promise.race([
      turnCompleted,
      new Promise((_, reject) => {
        abortController.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('Codex turn aborted'), { name: 'AbortError' }));
        }, { once: true });
      })
    ]);

    if (!state.failed) {
      emit({
        type: 'chat-complete',
        sessionId: currentSessionId,
        previousSessionId,
        turnId,
        usage: state.usage,
        hadAssistantText: state.hadAssistantText,
        completedAt: new Date().toISOString(),
        completionStatus: completion?.status || 'completed'
      });
    }
  } catch (error) {
    const wasAborted =
      error?.name === 'AbortError' ||
      run.status === 'aborted' ||
      String(error?.message || '').toLowerCase().includes('aborted');
    const userError = humanizeCodexFailure(error?.message || 'Codex app-server task failed');
    emit({
      type: wasAborted ? 'chat-aborted' : 'chat-error',
      sessionId: currentSessionId,
      turnId,
      error: wasAborted ? null : userError
    });
    if (!wasAborted) {
      console.error('[codex-app-server] Chat error:', userError);
    }
    // Try to interrupt the running turn on the app-server side.
    if (wasAborted && currentSessionId) {
      try {
        await client.request('turn/interrupt', {
          threadId: currentSessionId,
          turnId
        }, { timeoutMs: 5000 });
      } catch (interruptError) {
        // Best-effort: the server may already have given up.
        console.warn('[codex-app-server] turn/interrupt failed:', interruptError.message);
      }
    }
  } finally {
    // Resolve any approvals still pending for this turn so the app-server
    // doesn't hang during shutdown. Pool entries carry their own
    // timedOutResponse callback so they self-shape correctly.
    dropApprovalsForTurn(turnId);
    if (activeRuns.has(turnId)) {
      const r = activeRuns.get(turnId);
      r.status = r.status === 'aborted' ? 'aborted' : 'completed';
      activeRuns.delete(turnId);
    }
    client.close();
  }

  return currentSessionId;
}
