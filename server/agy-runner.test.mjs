import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgyArgs,
  cleanAgyEnv,
  createAgyStreamProcessor,
  mapAgyPermissionArgs
} from './agy-runner.js';

test('mapAgyPermissionArgs maps mobile permission modes to agy flags', () => {
  assert.deepEqual(mapAgyPermissionArgs('bypassPermissions'), ['--dangerously-skip-permissions']);
  assert.deepEqual(mapAgyPermissionArgs('plan'), ['--mode', 'plan']);
  assert.deepEqual(mapAgyPermissionArgs('acceptEdits'), ['--mode', 'accept-edits']);
  assert.deepEqual(mapAgyPermissionArgs('default'), ['--mode', 'accept-edits']);
});

test('buildAgyArgs places flags before -- prompt and avoids redundant --effort', () => {
  const argsWithSuffix = buildAgyArgs({
    prompt: '--leading-dash prompt',
    model: 'gemini-4-neon-high',
    reasoningEffort: 'xhigh',
    permissionMode: 'acceptEdits',
    resumeSessionId: 'conv-1'
  });
  assert.deepEqual(argsWithSuffix, [
    '-p',
    '--output-format',
    'stream-json',
    '--mode',
    'accept-edits',
    '--model',
    'gemini-4-neon-high',
    '--resume',
    'conv-1',
    '--',
    '--leading-dash prompt'
  ]);

  const argsWithoutSuffix = buildAgyArgs({
    prompt: 'hello',
    model: 'gemini-pro-orchestrator',
    reasoningEffort: 'high',
    permissionMode: 'bypassPermissions'
  });
  assert.ok(argsWithoutSuffix.includes('--effort'));
  assert.ok(argsWithoutSuffix.includes('high'));
  assert.ok(argsWithoutSuffix.includes('--dangerously-skip-permissions'));
});

test('cleanAgyEnv strips inherited Antigravity host session variables', () => {
  const cleaned = cleanAgyEnv({
    PATH: '/usr/bin',
    ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:9999',
    ANTIGRAVITY_CSRF_TOKEN: 'secret',
    ANTIGRAVITY_CONVERSATION_ID: 'conv-host',
    ANTIGRAVITY_PROJECT_ID: 'proj-host',
    KEEP_ME: 'ok'
  });
  assert.equal(cleaned.ANTIGRAVITY_LS_ADDRESS, undefined);
  assert.equal(cleaned.ANTIGRAVITY_CSRF_TOKEN, undefined);
  assert.equal(cleaned.ANTIGRAVITY_CONVERSATION_ID, undefined);
  assert.equal(cleaned.ANTIGRAVITY_PROJECT_ID, undefined);
  assert.equal(cleaned.KEEP_ME, 'ok');
});

test('createAgyStreamProcessor streams deltas, binds conversation_id, and handles errors', () => {
  const frames = [];
  const statuses = [];
  const state = { hadAssistantText: false, failed: false, usage: null };
  let currentId = 'draft-1';
  const processor = createAgyStreamProcessor({
    emit: (frame) => frames.push(frame),
    emitStatus: (_emit, status) => statuses.push(status),
    state,
    getSessionId: () => currentId,
    onConversationId: (id) => { currentId = id; },
    previousSessionId: 'draft-1',
    turnId: 'turn-1',
    requestedModel: 'gemini-4-neon-high'
  });

  processor({
    event: 'init',
    conversation_id: 'conv-real-1',
    init: { model: 'gemini-4-neon-high', cwd: '/tmp/repo' }
  });
  assert.equal(currentId, 'conv-real-1');
  assert.equal(statuses.at(-1).label, 'AGY gemini-4-neon-high');

  processor({
    event: 'step_update',
    step_update: { conversation_id: 'conv-real-1', step_index: 0, state: 'DONE', step_type: 'user_input' }
  });
  processor({
    event: 'step_update',
    step_update: { conversation_id: 'conv-real-1', step_index: 1, state: 'ACTIVE', step_type: 'run_command', tool_name: 'run_command' }
  });
  assert.equal(frames.at(-1).type, 'activity-update');
  assert.equal(frames.at(-1).kind, 'command_execution');

  processor({
    event: 'step_update',
    step_update: { conversation_id: 'conv-real-1', step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hel' }
  });
  processor({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-real-1',
      step_index: 2,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'lo',
      usage: { total_tokens: 42 }
    }
  });
  const assistantFrames = frames.filter((f) => f.type === 'assistant-update');
  assert.equal(assistantFrames.length, 2);
  assert.equal(assistantFrames[0].content, 'Hel');
  assert.equal(assistantFrames[1].content, 'Hello');
  assert.equal(assistantFrames[1].done, false);
  assert.equal(state.hadAssistantText, true);

  processor({
    event: 'result',
    result: { conversation_id: 'conv-real-1', status: 'SUCCESS', response: 'Hello', usage: { total_tokens: 42 } }
  });
  assert.equal(state.failed, false);
  assert.deepEqual(state.usage, { total_tokens: 42 });

  // Error result emits chat-error and marks failed.
  processor({
    event: 'result',
    result: { conversation_id: 'conv-real-1', status: 'ERROR', error: 'quota exceeded' }
  });
  assert.equal(state.failed, true);
  assert.equal(frames.at(-1).type, 'chat-error');
  assert.equal(frames.at(-1).error, 'quota exceeded');
});
