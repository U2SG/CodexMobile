import assert from 'node:assert/strict';
import test from 'node:test';
import {
  messagesFromDesktopThread,
  upsertDesktopActivity
} from './desktop-thread-projector.js';

test('desktop thread projector renders proposed plans and hides implemented requests', () => {
  const plan = '# 测试计划\n\n执行一个小改动。';
  const messages = messagesFromDesktopThread({
    id: 'session-1',
    turns: [
      {
        id: 'turn-1',
        startedAt: 1_800_000_000,
        items: [
          { id: 'user-1', type: 'userMessage', content: '/plan 写测试', timestamp: '2026-05-08T01:00:00.000Z' },
          {
            id: 'assistant-1',
            type: 'assistantMessage',
            content: `<proposed_plan>\n${plan}\n</proposed_plan>`,
            timestamp: '2026-05-08T01:00:05.000Z'
          }
        ]
      },
      {
        id: 'turn-2',
        startedAt: 1_800_000_010,
        items: [
          {
            id: 'user-2',
            type: 'userMessage',
            content: `PLEASE IMPLEMENT THIS PLAN:\n${plan}`,
            timestamp: '2026-05-08T01:00:10.000Z'
          }
        ]
      }
    ]
  });

  assert.deepEqual(messages.map((message) => message.role), ['user', 'plan', 'user']);
  assert.equal(messages[1].title, '测试计划');
  assert.equal(messages[2].content, '执行计划');
});

test('desktop activities insert beside the matching guided user segment', () => {
  const messages = [
    { id: 'user-1', role: 'user', turnId: 'turn-1', content: '先做 A', timestamp: '2026-05-08T01:00:00.000Z' },
    { id: 'assistant-1', role: 'assistant', turnId: 'turn-1', content: 'A 完成', timestamp: '2026-05-08T01:00:03.000Z' },
    { id: 'user-2', role: 'user', turnId: 'turn-1', segmentIndex: 1, content: '再做 B', timestamp: '2026-05-08T01:00:04.000Z' },
    { id: 'assistant-2', role: 'assistant', turnId: 'turn-1', content: 'B 完成', timestamp: '2026-05-08T01:00:08.000Z' }
  ];

  upsertDesktopActivity(messages, 'turn-1', {
    id: 'activity-1',
    kind: 'command_execution',
    timestamp: '2026-05-08T01:00:05.000Z'
  }, 1);

  assert.deepEqual(messages.map((message) => message.id), [
    'user-1',
    'assistant-1',
    'user-2',
    'activity-turn-1-1',
    'assistant-2'
  ]);
  assert.equal(messages[3].activities[0].id, 'activity-1');
});

test('codex 0.149 agentMessage items render as assistant bubbles, commentary folds into activity', () => {
  const thread = {
    id: 'session-1',
    turns: [
      {
        id: 'turn-1',
        items: [
          { id: 'user-1', type: 'userMessage', content: '看一下这个服务', timestamp: '2026-08-31T01:00:00.000Z' },
          {
            id: 'noise-1',
            type: 'userMessage',
            content: '# AGENTS.md instructions for D:\project\n<INSTRUCTIONS>…</INSTRUCTIONS>',
            timestamp: '2026-08-31T01:00:01.000Z'
          },
          {
            id: 'agent-1',
            type: 'agentMessage',
            phase: 'commentary',
            text: '我会先读一遍现有实现。',
            timestamp: '2026-08-31T01:00:02.000Z'
          },
          {
            id: 'agent-2',
            type: 'agentMessage',
            phase: 'final_answer',
            text: '结论：调度逻辑没问题。',
            timestamp: '2026-08-31T01:00:30.000Z'
          }
        ]
      }
    ]
  };

  const plain = messagesFromDesktopThread(thread);
  assert.deepEqual(
    plain.map((message) => [message.role, message.content]),
    [['user', '看一下这个服务'], ['assistant', '结论：调度逻辑没问题。']]
  );

  const withActivity = messagesFromDesktopThread(thread, { includeActivity: true });
  assert.deepEqual(withActivity.map((message) => message.role), ['user', 'activity', 'assistant']);
  assert.deepEqual(
    withActivity[1].activities.map((activity) => [activity.kind, activity.label]),
    [['agent_message', '我会先读一遍现有实现。']]
  );
});
