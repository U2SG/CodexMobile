// Phone approvals for Claude turns run through the Agent SDK. Same policy as
// the CLI path (PreToolUse hook script -> /api/internal/claude-approval), but
// in-process: no hook script, no loopback HTTP, no shared secret.
//
// Two SDK channels, on purpose:
// - A PreToolUse hook gates the risky tools. It fires even for calls the
//   user's settings allow-rules or acceptEdits would approve, which is what
//   the phone toggle promises. canUseTool alone would be skipped for those.
// - canUseTool is only how the SDK exposes AskUserQuestion (the tool is not
//   offered without it) and how its answers are returned. Any other tool that
//   reaches it was not pre-approved; deny it, as `claude -p` did.

import { registerApproval } from './approval-pool.js';
import {
  shapeClaudeDecision,
  shapeClaudeQuestionDecision,
  timedOutResponse
} from './claude-approval-route.js';

// Same tools the CLI hook matched, minus AskUserQuestion (canUseTool owns it).
export const CLAUDE_SDK_APPROVAL_MATCHER = 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit';

const ABORTED = {
  permissionDecision: 'deny',
  permissionDecisionReason: '任务已中止，工具调用被一并拒绝'
};

function askPhone({ kind, toolName, toolInput, turnId, sessionId, cwd, permissionMode, signal, broadcast }) {
  const { promise } = registerApproval({
    turnId,
    sessionId: sessionId || null,
    method: 'claude/PreToolUse',
    kind,
    requestParams: { toolName, toolInput: toolInput || {}, cwd: cwd || '', permissionMode: permissionMode || '' },
    signal,
    shapeDecision: kind === 'claudeQuestion' ? shapeClaudeQuestionDecision : shapeClaudeDecision,
    timedOutResponse,
    abortResponse: () => ABORTED,
    broadcast
  });
  return promise;
}

export function claudeSdkApprovalOptions({
  enabled,
  permissionMode,
  turnId,
  sessionId,
  cwd,
  signal,
  broadcast,
  ask = askPhone
}) {
  const context = { turnId, sessionId, cwd, permissionMode, signal, broadcast };
  const options = {
    canUseTool: async (toolName, input) => {
      if (toolName !== 'AskUserQuestion') {
        return { behavior: 'deny', message: `${toolName} 需要授权，当前权限模式未放行` };
      }
      const shaped = await ask({ ...context, kind: 'claudeQuestion', toolName, toolInput: input });
      if (shaped?.permissionDecision === 'allow') {
        return { behavior: 'allow', updatedInput: shaped.updatedInput || input };
      }
      return { behavior: 'deny', message: shaped?.permissionDecisionReason || '用户取消了问题' };
    }
  };
  // Full access: the user opted out of per-tool prompts (the CLI route
  // auto-allowed these), so no gating hook at all.
  if (!enabled || permissionMode === 'bypassPermissions') {
    return options;
  }
  options.hooks = {
    PreToolUse: [{
      matcher: CLAUDE_SDK_APPROVAL_MATCHER,
      hooks: [async (input) => {
        const shaped = await ask({ ...context, kind: 'claudeAction', toolName: input.tool_name, toolInput: input.tool_input });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: shaped?.permissionDecision || 'deny',
            permissionDecisionReason: shaped?.permissionDecisionReason || ''
          }
        };
      }]
    }]
  };
  return options;
}
