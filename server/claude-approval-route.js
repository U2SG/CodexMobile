// Internal HTTP endpoint hit by bin/claude-approval-hook.mjs when Claude's
// PreToolUse hook fires. The hook lives in a separate Node process spawned
// by Claude Code, so we can't share JS state directly — we long-poll over
// HTTP instead. Auth is a per-process shared secret passed via env to the
// hook script and matched on the X-Claude-Hook-Secret header here.
//
// Reuses the same approval-pool the Codex app-server runner uses, so all
// approvals (Codex sandbox escapes + Claude tool calls) surface through the
// same WS frame and ApprovalSheet UI.

import { registerApproval } from './approval-pool.js';
import { getClaudeHookSecret } from './approval-pool.js';

// Re-export so existing imports (server/index.js, tests) keep working
// without touching call sites. The canonical owner is approval-pool.js.
export { getClaudeHookSecret };

const CLAUDE_APPROVAL_PATH = '/api/internal/claude-approval';
const TIMEOUT_MS = 5 * 60 * 1000;

function shapeClaudeDecision(uiDecision) {
  const decision = uiDecision?.decision || 'denied';
  // PreToolUse hookSpecificOutput accepts allow | deny | ask. Both
  // "approved" and "approved_for_session" map to allow — Claude's hook
  // protocol has no session-wide opt-in shape; the server would have to
  // remember the choice across hook spawns to make that meaningful, which
  // we don't do yet.
  if (decision === 'approved' || decision === 'approved_for_session') {
    return {
      permissionDecision: 'allow',
      permissionDecisionReason: uiDecision?.reason || ''
    };
  }
  if (decision === 'denied' || decision === 'abort') {
    return {
      permissionDecision: 'deny',
      permissionDecisionReason: uiDecision?.reason || (decision === 'abort' ? '用户中止任务' : '用户拒绝')
    };
  }
  return {
    permissionDecision: 'ask',
    permissionDecisionReason: uiDecision?.reason || ''
  };
}

// AskUserQuestion is not an allow/deny approval — it's a multiple-choice
// question Claude wants the user to answer. The PWA renders the options as a
// form and ships the user's selection back as `answers` (keyed by question
// text → chosen label, or array of labels for multiSelect). We transcribe
// that into the only headless-supported shape: PreToolUse `allow` carrying
// `updatedInput.answers`, which Claude reads as the tool result and continues.
// Verified live against `claude -p` (sonnet) on 2026-05-31.
function shapeClaudeQuestionDecision(uiDecision, requestParams) {
  const decision = uiDecision?.decision || 'denied';
  if (decision === 'denied' || decision === 'abort') {
    return {
      permissionDecision: 'deny',
      permissionDecisionReason:
        uiDecision?.reason || (decision === 'abort' ? '用户中止任务' : '用户取消了问题'),
    };
  }
  const questions = Array.isArray(requestParams?.toolInput?.questions)
    ? requestParams.toolInput.questions
    : [];
  return {
    permissionDecision: 'allow',
    updatedInput: {
      questions,
      answers: uiDecision?.answers || {},
    },
  };
}

function timedOutResponse() {
  return {
    permissionDecision: 'deny',
    permissionDecisionReason: 'CodexMobile 审批 5 分钟无回应，默认拒绝'
  };
}

async function readJsonBody(req, { limit = 1_000_000 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const error = new Error('请求体超过限制');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    const err = new Error('请求体不是合法 JSON');
    err.statusCode = 400;
    err.cause = error;
    throw err;
  }
}

export function createClaudeApprovalRoute({ broadcast }) {
  if (typeof broadcast !== 'function') {
    throw new Error('createClaudeApprovalRoute requires a broadcast function');
  }

  // Returns true when the request was handled — matches the existing
  // *.preAuthHandle(req, res, { method, pathname }) shape used by handleApi.
  return {
    async preAuthHandle(req, res, { method, pathname }) {
      if (pathname !== CLAUDE_APPROVAL_PATH) return false;
      if (method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'method-not-allowed' }));
        return true;
      }
      const headerSecret = String(req.headers['x-claude-hook-secret'] || '');
      if (!headerSecret || headerSecret !== getClaudeHookSecret()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return true;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        res.writeHead(error.statusCode || 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
        return true;
      }
      const turnId = String(body.turnId || '').trim();
      if (!turnId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'turnId required' }));
        return true;
      }
      const requestParams = {
        toolName: body.toolName || '',
        toolInput: body.toolInput || {},
        cwd: body.cwd || '',
        permissionMode: body.permissionMode || ''
      };
      const isQuestion = requestParams.toolName === 'AskUserQuestion';
      // Full access (bypassPermissions): the user opted out of per-tool
      // approvals, so auto-allow action tools without surfacing a prompt.
      // AskUserQuestion is the one exception — it's a question, not a
      // permission, and the hook is its only headless channel to be answered.
      if (requestParams.permissionMode === 'bypassPermissions' && !isQuestion) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          permissionDecision: 'allow',
          permissionDecisionReason: '完全访问模式：自动放行'
        }));
        return true;
      }
      const { promise } = registerApproval({
        turnId,
        sessionId: String(body.sessionId || '') || null,
        method: 'claude/PreToolUse',
        kind: isQuestion ? 'claudeQuestion' : 'claudeAction',
        requestParams,
        shapeDecision: isQuestion ? shapeClaudeQuestionDecision : shapeClaudeDecision,
        timedOutResponse,
        abortResponse: () => ({
          permissionDecision: 'deny',
          permissionDecisionReason: '任务已中止，工具调用被一并拒绝'
        }),
        timeoutMs: TIMEOUT_MS,
        broadcast
      });
      try {
        const shaped = await promise;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(shaped));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          permissionDecision: 'allow',
          permissionDecisionReason: `CodexMobile 审批通道异常: ${error.message}; fail-open`
        }));
      }
      return true;
    }
  };
}
