import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activityStepFromPayload,
  completeActivityMessagesForTurn,
  dismissPlanImplementationPrompts,
  isPlaceholderActivityMessage,
  isVisibleActivityStep,
  shouldRenderActivityMessageInChat,
  upsertActivityMessage,
  upsertAssistantMessage,
  upsertStatusMessage
} from './chat/activity-model.js';

test('upsertActivityMessage keeps concrete MCP tool calls with generic status labels', () => {
  const result = upsertActivityMessage([], {
    sessionId: 'session-1',
    turnId: 'turn-1',
    messageId: 'tool-1',
    kind: 'mcp_tool_call',
    status: 'completed',
    label: '已完成一步操作',
    detail: 'functions.exec_command',
    toolName: 'exec_command'
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].role, 'activity');
  assert.equal(result[0].activities.length, 1);
  assert.equal(result[0].activities[0].kind, 'mcp_tool_call');
  assert.equal(result[0].activities[0].detail, 'functions.exec_command');
});

test('upsertStatusMessage keeps concrete dynamic tool calls with generic status labels', () => {
  const result = upsertStatusMessage([], {
    sessionId: 'session-1',
    turnId: 'turn-1',
    kind: 'dynamic_tool_call',
    status: 'completed',
    label: '已完成一步操作',
    detail: 'web.run',
    toolName: 'web.run'
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].role, 'activity');
  assert.equal(result[0].activities.length, 1);
  assert.equal(result[0].activities[0].kind, 'dynamic_tool_call');
  assert.equal(result[0].activities[0].detail, 'web.run');
});

test('upsertStatusMessage merges desktop turn updates back into the optimistic mobile card', () => {
  const current = upsertStatusMessage([], {
    sessionId: 'thread-1',
    turnId: 'client-turn-1',
    kind: 'reasoning',
    status: 'running',
    label: '正在思考中',
    timestamp: '2026-05-09T00:00:00.000Z'
  });

  const result = upsertStatusMessage(current, {
    sessionId: 'thread-1',
    turnId: 'desktop-turn-1',
    clientTurnId: 'client-turn-1',
    kind: 'mcp_tool_call',
    status: 'running',
    label: '正在完成一步操作',
    detail: 'functions.exec_command',
    toolName: 'exec_command',
    timestamp: '2026-05-09T00:00:05.000Z'
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'status-client-turn-1');
  assert.equal(result[0].turnId, 'desktop-turn-1');
  assert.equal(result[0].clientTurnId, 'client-turn-1');
  assert.deepEqual(result[0].activities.map((activity) => activity.kind), ['reasoning', 'mcp_tool_call']);
});

test('upsertActivityMessage also merges desktop activity updates by client turn id', () => {
  const current = upsertStatusMessage([], {
    sessionId: 'thread-1',
    turnId: 'client-turn-1',
    kind: 'reasoning',
    status: 'running',
    label: '正在思考中'
  });

  const result = upsertActivityMessage(current, {
    sessionId: 'thread-1',
    turnId: 'desktop-turn-1',
    clientTurnId: 'client-turn-1',
    kind: 'mcp_tool_call',
    status: 'running',
    label: '正在完成一步操作',
    detail: 'functions.exec_command',
    toolName: 'exec_command'
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'status-client-turn-1');
  assert.equal(result[0].turnId, 'desktop-turn-1');
  assert.equal(result[0].clientTurnId, 'client-turn-1');
  assert.deepEqual(result[0].activities.map((activity) => activity.kind), ['reasoning', 'mcp_tool_call']);
});

test('completeActivityMessagesForTurn marks running activity steps completed', () => {
  const result = completeActivityMessagesForTurn([
    {
      id: 'status-turn-1',
      role: 'activity',
      sessionId: 'session-1',
      turnId: 'turn-1',
      status: 'running',
      activities: [
        { id: 'thinking', kind: 'reasoning', label: '正在思考', status: 'running' },
        { id: 'tool', kind: 'mcp_tool_call', label: '执行操作', status: 'queued' }
      ]
    }
  ], {
    sessionId: 'session-1',
    turnId: 'turn-1',
    completedAt: '2026-05-08T00:00:00.000Z'
  });

  assert.equal(result[0].status, 'completed');
  assert.deepEqual(result[0].activities.map((activity) => activity.status), ['completed', 'completed']);
});

test('completeActivityMessagesForTurn keeps pending plan implementation actionable', () => {
  const result = completeActivityMessagesForTurn([
    {
      id: 'status-turn-1',
      role: 'activity',
      sessionId: 'thread-1',
      turnId: 'turn-1',
      status: 'running',
      activities: [
        {
          id: 'implement-plan:app-turn-1',
          kind: 'plan_implementation',
          label: '等待确认执行计划',
          status: 'running',
          planImplementation: {
            requestId: 'implement-plan:app-turn-1',
            turnId: 'app-turn-1',
            planContent: '1. 修复',
            completed: false
          }
        }
      ]
    }
  ], {
    sessionId: 'thread-1',
    turnId: 'turn-1',
    completedAt: '2026-05-08T02:00:05.000Z'
  });

  assert.equal(result[0].status, 'completed');
  assert.equal(result[0].activities[0].status, 'running');
  assert.equal(result[0].activities[0].planImplementation.completed, false);
});

test('placeholder thinking activity is suppressed from chat stream', () => {
  assert.equal(isPlaceholderActivityMessage({
    id: 'status-turn-1',
    role: 'activity',
    status: 'running',
    activities: [
      { id: 'thinking', kind: 'reasoning', label: '正在思考中', status: 'running' }
    ]
  }), true);
});

test('activity with concrete work is not treated as placeholder', () => {
  assert.equal(isPlaceholderActivityMessage({
    id: 'status-turn-1',
    role: 'activity',
    status: 'running',
    activities: [
      { id: 'thinking', kind: 'reasoning', label: '正在思考中', status: 'running' },
      { id: 'tool', kind: 'mcp_tool_call', label: '正在执行命令', detail: 'functions.exec_command', status: 'running' }
    ]
  }), false);
});

test('transient local handoff activity is kept for runtime but hidden from chat stream', () => {
  assert.equal(shouldRenderActivityMessageInChat({
    id: 'status-client-turn-1',
    role: 'activity',
    source: 'local-handoff',
    transient: true,
    status: 'running',
    label: '后台启动中',
    activities: [
      { id: 'handoff', kind: 'turn', label: '后台启动中', status: 'running' }
    ]
  }), false);
});

test('real activity still renders in the chat stream', () => {
  assert.equal(shouldRenderActivityMessageInChat({
    id: 'status-turn-1',
    role: 'activity',
    status: 'running',
    activities: [
      { id: 'tool', kind: 'mcp_tool_call', label: '运行命令', detail: 'functions.exec_command', status: 'running' }
    ]
  }), true);
});

test('plan implementation activity is visible and preserves confirmation payload', () => {
  const step = activityStepFromPayload({
    sessionId: 'thread-1',
    turnId: 'turn-1',
    messageId: 'implement-plan:turn-1',
    kind: 'plan_implementation',
    status: 'running',
    label: '等待确认执行计划',
    detail: '1. 定位同步链路',
    planImplementation: {
      requestId: 'implement-plan:turn-1',
      turnId: 'turn-1',
      planContent: '1. 定位同步链路',
      completed: false
    }
  });

  assert.equal(isVisibleActivityStep(step, 'completed'), true);
  assert.deepEqual(step.planImplementation, {
    requestId: 'implement-plan:turn-1',
    turnId: 'turn-1',
    planContent: '1. 定位同步链路',
    completed: false
  });
});

test('upsertAssistantMessage merges multiple assistant messages from the same turn into one bubble', () => {
  // Claude often emits two distinct Anthropic messages in one user turn
  // (text → tool_use → text); each has its own msg_xxx. Pre-fix this rendered
  // as two separate bubbles. New behavior: same turnId collapses into a
  // single assistant message with content joined by a blank line, keyed by
  // the first messageId so later partial-stream updates can still locate it.
  let messages = upsertAssistantMessage([], {
    sessionId: 'thread-1',
    turnId: 'turn-1',
    messageId: 'msg_a',
    content: 'first half',
    done: true
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 'msg_a');
  assert.equal(messages[0].content, 'first half');

  messages = upsertAssistantMessage(messages, {
    sessionId: 'thread-1',
    turnId: 'turn-1',
    messageId: 'msg_b',
    content: 'second half',
    done: true
  });
  assert.equal(messages.length, 1, 'same-turn assistant messages must collapse to one bubble');
  assert.equal(messages[0].id, 'msg_a', 'bubble id stays anchored to the first messageId');
  assert.equal(messages[0].content, 'first half\n\nsecond half');

  // Streaming partials of msg_b should keep replacing only msg_b's segment.
  messages = upsertAssistantMessage(messages, {
    sessionId: 'thread-1',
    turnId: 'turn-1',
    messageId: 'msg_b',
    content: 'second half rev',
    done: false
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'first half\n\nsecond half rev');
});

test('upsertAssistantMessage does not merge across different turnIds', () => {
  let messages = upsertAssistantMessage([], {
    sessionId: 'thread-1',
    turnId: 'turn-1',
    messageId: 'msg_a',
    content: 'turn 1 reply',
    done: true
  });
  messages = upsertAssistantMessage(messages, {
    sessionId: 'thread-1',
    turnId: 'turn-2',
    messageId: 'msg_b',
    content: 'turn 2 reply',
    done: true
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, 'turn 1 reply');
  assert.equal(messages[1].content, 'turn 2 reply');
});

test('upsertAssistantMessage renders proposed plans as standalone plan messages', () => {
  const result = upsertAssistantMessage([], {
    sessionId: 'thread-1',
    turnId: 'turn-1',
    messageId: 'assistant-plan-1',
    content: '<proposed_plan>\n# 移动端计划模式测试计划\n\n## Summary\n创建一个轻量测试计划。\n</proposed_plan>'
  });

  assert.deepEqual(result.map((message) => message.role), ['plan', 'plan_request']);
  assert.equal(result[0].id, 'assistant-plan-1-plan');
  assert.equal(result[0].title, '移动端计划模式测试计划');
  assert.equal(result[0].content, '# 移动端计划模式测试计划\n\n## Summary\n创建一个轻量测试计划。');
  assert.deepEqual(result[1].planImplementation, {
    requestId: 'implement-plan:turn-1',
    turnId: 'turn-1',
    planContent: '# 移动端计划模式测试计划\n\n## Summary\n创建一个轻量测试计划。',
    completed: false
  });
});

test('dismissPlanImplementationPrompts removes the plan request after a choice is submitted', () => {
  const result = dismissPlanImplementationPrompts([
    {
      id: 'plan-1',
      role: 'plan',
      content: '1. 定位同步链路'
    },
    {
      id: 'request-1',
      role: 'plan_request',
      content: '实施此计划?',
      planImplementation: {
        requestId: 'implement-plan:turn-1',
        turnId: 'turn-1',
        planContent: '1. 定位同步链路',
        completed: false
      }
    },
    {
      id: 'activity-1',
      role: 'activity',
      status: 'completed',
      activities: [
        {
          id: 'step-1',
          kind: 'plan_implementation',
          status: 'completed',
          label: '等待确认执行计划',
          planImplementation: {
            requestId: 'implement-plan:turn-1',
            turnId: 'turn-1',
            planContent: '1. 定位同步链路',
            completed: false
          }
        }
      ]
    }
  ], {
    requestId: 'implement-plan:turn-1',
    turnId: 'turn-1',
    planContent: '1. 定位同步链路'
  });

  assert.deepEqual(result.map((message) => message.role), ['plan', 'activity']);
  assert.equal(result[1].activities[0].planImplementation.completed, true);
  assert.equal(isVisibleActivityStep(result[1].activities[0], result[1].status), false);
  assert.equal(shouldRenderActivityMessageInChat(result[1]), false);
});
