import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeLiveSelectedThreadMessages,
  shouldPollSelectedSessionMessages
} from './session-live-refresh.js';

test('shouldPollSelectedSessionMessages keeps normal running sessions protected', () => {
  assert.equal(
    shouldPollSelectedSessionMessages({
      hasSelectedRunning: true,
      desktopBridge: { connected: true, mode: 'desktop-proxy' }
    }),
    false
  );
});

test('shouldPollSelectedSessionMessages allows external desktop sessions to refresh', () => {
  assert.equal(
    shouldPollSelectedSessionMessages({
      hasSelectedRunning: true,
      desktopBridge: { connected: true, mode: 'desktop-ipc' },
      hasExternalThreadRefresh: true
    }),
    true
  );
  assert.equal(
    shouldPollSelectedSessionMessages({
      hasSelectedRunning: true,
      desktopBridge: { connected: true, mode: 'headless-local' },
      hasExternalThreadRefresh: true
    }),
    true
  );
});

test('shouldPollSelectedSessionMessages protects local streaming runs when desktop-ipc is only a global bridge', () => {
  assert.equal(
    shouldPollSelectedSessionMessages({
      hasSelectedRunning: true,
      desktopBridge: { connected: true, mode: 'desktop-ipc' },
      hasExternalThreadRefresh: false
    }),
    false
  );
});

test('mergeLiveSelectedThreadMessages preserves local pending send until loaded thread contains it', () => {
  const current = [
    { id: 'old-user', role: 'user', content: '之前的问题', timestamp: '2026-05-07T06:00:00.000Z' },
    { id: 'old-assistant', role: 'assistant', content: '之前的回答', timestamp: '2026-05-07T06:00:01.000Z' },
    { id: 'local-1', role: 'user', content: '手机刚发的新消息', timestamp: '2026-05-07T06:01:00.000Z' },
    { id: 'status-1', role: 'activity', status: 'running', content: '已交给桌面端处理', timestamp: '2026-05-07T06:01:00.000Z' }
  ];
  const loaded = current.slice(0, 2);

  const merged = mergeLiveSelectedThreadMessages(current, loaded);

  assert.deepEqual(merged.map((message) => message.id), ['old-user', 'old-assistant', 'local-1', 'status-1']);
});

test('mergeLiveSelectedThreadMessages switches to loaded messages once the thread catches up', () => {
  const current = [
    { id: 'old-user', role: 'user', content: '之前的问题', timestamp: '2026-05-07T06:00:00.000Z' },
    { id: 'local-1', role: 'user', content: '手机刚发的新消息', timestamp: '2026-05-07T06:01:00.000Z' },
    { id: 'status-1', role: 'activity', status: 'running', content: '已交给桌面端处理', timestamp: '2026-05-07T06:01:00.000Z' }
  ];
  const loaded = [
    { id: 'old-user', role: 'user', content: '之前的问题', timestamp: '2026-05-07T06:00:00.000Z' },
    { id: 'desktop-user', role: 'user', content: '手机刚发的新消息', timestamp: '2026-05-07T06:01:00.000Z' },
    { id: 'desktop-activity', role: 'activity', status: 'running', content: '正在处理本地任务', timestamp: '2026-05-07T06:01:01.000Z' }
  ];

  const merged = mergeLiveSelectedThreadMessages(current, loaded);

  assert.deepEqual(merged.map((message) => message.id), ['old-user', 'desktop-user', 'desktop-activity']);
});

test('mergeLiveSelectedThreadMessages keeps local activity when loaded messages omit process records', () => {
  const current = [
    { id: 'local-user', role: 'user', content: '状态显示自测', sessionId: 'thread-1', turnId: 'turn-1', timestamp: '2026-05-07T06:01:00.000Z' },
    {
      id: 'status-turn-1',
      role: 'activity',
      status: 'running',
      sessionId: 'thread-1',
      turnId: 'turn-1',
      content: '正在处理',
      timestamp: '2026-05-07T06:01:01.000Z',
      activities: [
        { id: 'thinking', kind: 'reasoning', label: '正在思考', status: 'running' },
        { id: 'cmd', kind: 'command_execution', label: '运行命令', status: 'completed', command: 'date' }
      ]
    }
  ];
  const loaded = [
    { id: 'desktop-user', role: 'user', content: '状态显示自测', sessionId: 'thread-1', turnId: 'turn-1', timestamp: '2026-05-07T06:01:00.000Z' },
    { id: 'desktop-assistant', role: 'assistant', content: '完成', sessionId: 'thread-1', turnId: 'turn-1', timestamp: '2026-05-07T06:01:08.000Z' }
  ];

  const merged = mergeLiveSelectedThreadMessages(current, loaded);

  assert.deepEqual(merged.map((message) => message.id), ['desktop-user', 'status-turn-1', 'desktop-assistant']);
  assert.equal(merged[1].status, 'completed');
  assert.equal(merged[1].activities[0].status, 'completed');
});
