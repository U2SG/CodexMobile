import assert from 'node:assert/strict';
import test from 'node:test';

import { createDesktopTurnMonitor } from './desktop-turn-monitor.js';

function createManualTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn, delay) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    async tick() {
      const entries = [...timers.entries()];
      timers.clear();
      for (const [, timer] of entries) {
        await timer.fn();
      }
    },
    count() {
      return timers.size;
    }
  };
}

test('desktop turn monitor broadcasts completion after assistant appears after the mobile user message', async () => {
  const timers = createManualTimers();
  const broadcasts = [];
  const remembered = [];
  const autoNameRequests = [];
  const responses = [
    {
      messages: [
        { id: 'old-user', role: 'user', content: '之前的问题', timestamp: '2026-05-08T08:00:00.000Z' },
        { id: 'old-assistant', role: 'assistant', content: '之前的回答', timestamp: '2026-05-08T08:00:10.000Z' },
        { id: 'desktop-user', role: 'user', content: '继续优化同步逻辑', timestamp: '2026-05-08T08:01:00.000Z' }
      ],
      context: { inputTokens: 100 }
    },
    {
      messages: [
        { id: 'old-user', role: 'user', content: '之前的问题', timestamp: '2026-05-08T08:00:00.000Z' },
        { id: 'old-assistant', role: 'assistant', content: '之前的回答', timestamp: '2026-05-08T08:00:10.000Z' },
        { id: 'desktop-user', role: 'user', content: '继续优化同步逻辑', timestamp: '2026-05-08T08:01:00.000Z' },
        { id: 'desktop-assistant', role: 'assistant', content: '同步逻辑已完成。', timestamp: '2026-05-08T08:01:30.000Z' }
      ],
      context: { inputTokens: 120 }
    }
  ];
  const monitor = createDesktopTurnMonitor({
    readSessionMessages: async (sessionId, options) => {
      assert.equal(sessionId, 'thread-1');
      assert.equal(options.includeActivity, false);
      return responses.shift() || responses.at(-1);
    },
    refreshCodexCache: async () => ({ syncedAt: 'sync-1', projects: [{ id: 'project-1' }] }),
    rememberTurn: (turnId, patch) => remembered.push([turnId, patch]),
    broadcast: (payload) => broadcasts.push(payload),
    scheduleAutoNameCompletedSession: (payload) => autoNameRequests.push(payload),
    now: () => '2026-05-08T08:01:31.000Z',
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    pollDelays: [1, 1]
  });

  monitor.startRun({
    projectId: 'project-1',
    sessionId: 'thread-1',
    previousSessionId: 'thread-1',
    turnId: 'desktop-turn-1',
    clientTurnId: 'client-turn-1',
    userMessage: '继续优化同步逻辑',
    startedAt: '2026-05-08T08:01:00.000Z'
  });

  assert.deepEqual(monitor.getActiveRuns().map((run) => run.turnId), ['desktop-turn-1']);
  await timers.tick();
  assert.equal(monitor.getActiveRuns().length, 1);
  await timers.tick();

  assert.equal(monitor.getActiveRuns().length, 0);
  assert.deepEqual(
    broadcasts.map((payload) => payload.type),
    ['status-update', 'chat-complete', 'sync-complete']
  );
  assert.equal(broadcasts[0].source, 'desktop-ipc');
  assert.equal(broadcasts[1].source, 'desktop-ipc');
  assert.equal(broadcasts[1].turnId, 'desktop-turn-1');
  assert.equal(broadcasts[1].clientTurnId, 'client-turn-1');
  assert.equal(broadcasts[1].hadAssistantText, true);
  assert.deepEqual(broadcasts[1].context, { inputTokens: 120 });
  assert.deepEqual(
    remembered.map(([turnId, patch]) => [turnId, patch.status, patch.source]),
    [
      ['desktop-turn-1', 'running', 'desktop-ipc'],
      ['client-turn-1', 'running', 'desktop-ipc'],
      ['desktop-turn-1', 'completed', 'desktop-ipc'],
      ['client-turn-1', 'completed', 'desktop-ipc']
    ]
  );
  assert.deepEqual(autoNameRequests, [
    {
      sessionId: 'thread-1',
      turnId: 'client-turn-1',
      userMessage: '继续优化同步逻辑'
    }
  ]);
});

test('desktop turn monitor keeps running when desktop thread has not caught up yet', async () => {
  const timers = createManualTimers();
  const broadcasts = [];
  const monitor = createDesktopTurnMonitor({
    readSessionMessages: async () => ({
      messages: [
        { id: 'old-user', role: 'user', content: '之前的问题', timestamp: '2026-05-08T08:00:00.000Z' },
        { id: 'old-assistant', role: 'assistant', content: '之前的回答', timestamp: '2026-05-08T08:00:10.000Z' }
      ]
    }),
    refreshCodexCache: async () => ({ syncedAt: 'sync-1', projects: [] }),
    rememberTurn: () => null,
    broadcast: (payload) => broadcasts.push(payload),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    pollDelays: [1, 1, 1],
    maxPolls: 10
  });

  monitor.startRun({
    projectId: 'project-1',
    sessionId: 'thread-1',
    previousSessionId: 'thread-1',
    turnId: 'desktop-turn-1',
    clientTurnId: 'client-turn-1',
    userMessage: '桌面端还没追上',
    startedAt: '2026-05-08T08:01:00.000Z'
  });

  await timers.tick();
  await timers.tick();

  assert.equal(monitor.hasActiveWork('thread-1'), true);
  assert.equal(monitor.getActiveRuns().length, 1);
  assert.deepEqual(broadcasts.map((payload) => payload.type), ['status-update']);
});

test('desktop turn monitor aborts by session id and removes active state', async () => {
  const timers = createManualTimers();
  const broadcasts = [];
  const remembered = [];
  const monitor = createDesktopTurnMonitor({
    readSessionMessages: async () => ({ messages: [] }),
    refreshCodexCache: async () => ({ syncedAt: 'sync-1', projects: [] }),
    rememberTurn: (turnId, patch) => remembered.push([turnId, patch]),
    broadcast: (payload) => broadcasts.push(payload),
    now: () => '2026-05-08T08:02:00.000Z',
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    pollDelays: [1, 1]
  });

  monitor.startRun({
    projectId: 'project-1',
    sessionId: 'thread-1',
    previousSessionId: 'draft-thread-1',
    turnId: 'desktop-turn-1',
    clientTurnId: 'client-turn-1',
    userMessage: '准备中止',
    startedAt: '2026-05-08T08:01:00.000Z'
  });

  assert.equal(monitor.abortRun('thread-1'), true);
  await timers.tick();

  assert.equal(monitor.getActiveRuns().length, 0);
  assert.equal(timers.count(), 0);
  assert.deepEqual(broadcasts.map((payload) => payload.type), ['status-update', 'chat-aborted']);
  assert.equal(broadcasts[1].source, 'desktop-ipc');
  assert.equal(broadcasts[1].sessionId, 'thread-1');
  assert.equal(broadcasts[1].turnId, 'desktop-turn-1');
  assert.deepEqual(
    remembered.map(([turnId, patch]) => [turnId, patch.status]),
    [
      ['desktop-turn-1', 'running'],
      ['client-turn-1', 'running'],
      ['desktop-turn-1', 'aborted'],
      ['client-turn-1', 'aborted']
    ]
  );
});
