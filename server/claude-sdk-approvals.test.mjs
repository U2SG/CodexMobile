import assert from 'node:assert/strict';
import test from 'node:test';
import { CLAUDE_SDK_APPROVAL_MATCHER, claudeSdkApprovalOptions } from './claude-sdk-approvals.js';

const base = { turnId: 't1', sessionId: 's1', cwd: 'C:\\repo', signal: null, broadcast: () => {} };

test('hooks gate the risky tools unless approvals are off or the mode is full access', () => {
  const gated = claudeSdkApprovalOptions({ ...base, enabled: true, permissionMode: 'default', ask: async () => ({}) });
  assert.equal(gated.hooks.PreToolUse[0].matcher, CLAUDE_SDK_APPROVAL_MATCHER);
  for (const tool of ['Bash', 'Write', 'Edit']) assert.match(tool, new RegExp(`^(${CLAUDE_SDK_APPROVAL_MATCHER})$`));
  assert.doesNotMatch('Read', new RegExp(`^(${CLAUDE_SDK_APPROVAL_MATCHER})$`));

  assert.equal(claudeSdkApprovalOptions({ ...base, enabled: false, permissionMode: 'default' }).hooks, undefined);
  assert.equal(claudeSdkApprovalOptions({ ...base, enabled: true, permissionMode: 'bypassPermissions' }).hooks, undefined);
});

test('the hook relays the phone decision as PreToolUse output', async () => {
  const asked = [];
  const options = claudeSdkApprovalOptions({
    ...base,
    enabled: true,
    permissionMode: 'default',
    ask: async (request) => {
      asked.push(request);
      return { permissionDecision: 'deny', permissionDecisionReason: '用户拒绝' };
    }
  });
  const output = await options.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Bash', tool_input: { command: 'rm -rf x' } });
  assert.deepEqual(output.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '用户拒绝' });
  assert.equal(asked[0].kind, 'claudeAction');
  assert.equal(asked[0].toolInput.command, 'rm -rf x');
  assert.equal(asked[0].turnId, 't1');
});

test('canUseTool answers AskUserQuestion from the phone and denies anything else', async () => {
  const options = claudeSdkApprovalOptions({
    ...base,
    enabled: false,
    permissionMode: 'bypassPermissions',
    ask: async ({ kind, toolInput }) => {
      assert.equal(kind, 'claudeQuestion');
      return { permissionDecision: 'allow', updatedInput: { questions: toolInput.questions, answers: { 'Color?': 'Blue' } } };
    }
  });
  const answered = await options.canUseTool('AskUserQuestion', { questions: [{ question: 'Color?' }] });
  assert.deepEqual(answered, { behavior: 'allow', updatedInput: { questions: [{ question: 'Color?' }], answers: { 'Color?': 'Blue' } } });

  const denied = await options.canUseTool('WebFetch', { url: 'https://example.com' });
  assert.equal(denied.behavior, 'deny');
});

test('a cancelled question becomes a deny with the reason', async () => {
  const options = claudeSdkApprovalOptions({
    ...base,
    enabled: true,
    permissionMode: 'default',
    ask: async () => ({ permissionDecision: 'deny', permissionDecisionReason: '用户取消了问题' })
  });
  assert.deepEqual(await options.canUseTool('AskUserQuestion', { questions: [] }), { behavior: 'deny', message: '用户取消了问题' });
});
