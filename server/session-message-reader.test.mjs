import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createSessionMessageReader,
  messagesFromRolloutJsonl,
  readRolloutContextState
} from './session-message-reader.js';

test('session message reader filters hidden messages, paginates, and exposes context status', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-message-reader-'));
  try {
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    await fs.writeFile(rolloutPath, [
      JSON.stringify({
        timestamp: '2026-05-08T01:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 100000,
            last_token_usage: { input_tokens: 25000 },
            total_token_usage: { total_tokens: 30000 }
          }
        }
      }),
      JSON.stringify({
        timestamp: '2026-05-08T01:01:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 100000,
            last_token_usage: { input_tokens: 10000 },
            total_token_usage: { total_tokens: 13000 }
          }
        }
      })
    ].join('\n'));

    const reader = createSessionMessageReader({
      readDeletedMessageIds: async () => new Set(['message-2']),
      readDesktopThread: async (sessionId, options) => {
        assert.equal(sessionId, 'session-1');
        assert.deepEqual(options, { includeTurns: true });
        return { thread: { id: 'session-1', path: rolloutPath, turns: [] } };
      },
      messagesFromDesktopThread: () => [
        { id: 'message-1', role: 'user', content: 'first', timestamp: '2026-05-08T01:00:00.000Z' },
        { id: 'message-2', role: 'assistant', content: 'hidden', timestamp: '2026-05-08T01:01:00.000Z' },
        { id: 'message-3', role: 'assistant', content: 'last', timestamp: '2026-05-08T01:02:00.000Z' }
      ],
      getConfigContext: () => ({ autoCompactTokenLimit: 80000 })
    });

    const result = await reader.readSessionMessages('session-1', { limit: 1, latest: true });

    assert.deepEqual(result.messages.map((message) => message.id), ['message-3']);
    assert.equal(result.total, 2);
    assert.equal(result.offset, 1);
    assert.equal(result.hasMoreBefore, true);
    assert.equal(result.context.inputTokens, 10000);
    assert.equal(result.context.contextWindow, 100000);
    assert.equal(result.context.autoCompact.detected, true);
    assert.equal(result.context.autoCompact.reason, '上下文用量回落');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rollout context state exposes running desktop runtime until task completion', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-runtime-state-'));
  try {
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    const startedRows = [
      JSON.stringify({
        timestamp: '2026-05-08T01:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-1',
          started_at: 1778202000,
          model_context_window: 100000
        }
      }),
      JSON.stringify({
        timestamp: '2026-05-08T01:00:01.000Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1', model: 'gpt-5.5' }
      })
    ];
    await fs.writeFile(rolloutPath, startedRows.join('\n'));

    const running = await readRolloutContextState(rolloutPath, 'session-1');

    assert.equal(running.runtime.status, 'running');
    assert.equal(running.runtime.source, 'desktop-thread');
    assert.equal(running.runtime.sessionId, 'session-1');
    assert.equal(running.runtime.turnId, 'turn-1');

    await fs.writeFile(rolloutPath, [
      ...startedRows,
      JSON.stringify({
        timestamp: '2026-05-08T01:00:10.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-1' }
      })
    ].join('\n'));

    const completed = await readRolloutContextState(rolloutPath, 'session-1');

    assert.equal(completed.runtime, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('session message reader merges raw and collaboration activities only when requested', async () => {
  const calls = [];
  const reader = createSessionMessageReader({
    readDeletedMessageIds: async () => new Set(),
    readDesktopThread: async () => ({
      thread: { id: 'session-1', path: '/tmp/rollout.jsonl', turns: [{ id: 'turn-1' }] }
    }),
    messagesFromDesktopThread: (_thread, options) => {
      calls.push(['messagesFromDesktopThread', options.includeActivity]);
      return [{ id: 'message-1', role: 'user', content: 'hi', timestamp: '2026-05-08T01:00:00.000Z' }];
    },
    readRawSessionActivities: async (filePath, turns) => {
      calls.push(['raw', filePath, turns.length]);
      return [{ turnId: 'turn-1', activity: { id: 'raw-1', kind: 'command_execution', timestamp: '2026-05-08T01:01:00.000Z' } }];
    },
    readDesktopCollabActivities: async (filePath) => {
      calls.push(['collab', filePath]);
      return [{ turnId: 'turn-1', activity: { id: 'collab-1', kind: 'agent_message', timestamp: '2026-05-08T01:02:00.000Z' } }];
    },
    removeFallbackActivitiesCoveredByRaw: (items, raw) => calls.push(['removeFallback', items.length, raw.length]),
    upsertDesktopActivity: (items, turnId, activity) => {
      calls.push(['upsert', turnId, activity.id]);
      items.push({ id: activity.id, role: 'activity', timestamp: activity.timestamp });
    },
    sortDesktopActivitySteps: (items) => {
      calls.push(['sort', items.length]);
      items.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    },
    readRolloutContextState: async () => ({ sessionId: 'session-1' })
  });

  const withoutActivity = await reader.readSessionMessages('session-1', { includeActivity: false });
  assert.deepEqual(withoutActivity.messages.map((message) => message.id), ['message-1']);
  assert.deepEqual(calls, [['messagesFromDesktopThread', false]]);

  calls.length = 0;
  const withActivity = await reader.readSessionMessages('session-1', { includeActivity: true });
  assert.deepEqual(withActivity.messages.map((message) => message.id), ['message-1', 'raw-1', 'collab-1']);
  assert.deepEqual(calls, [
    ['messagesFromDesktopThread', true],
    ['raw', '/tmp/rollout.jsonl', 1],
    ['removeFallback', 1, 1],
    ['upsert', 'turn-1', 'raw-1'],
    ['collab', '/tmp/rollout.jsonl'],
    ['upsert', 'turn-1', 'collab-1'],
    ['sort', 3]
  ]);
});

test('session message reader falls back to rollout jsonl when desktop thread is not loaded', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-message-reader-rollout-'));
  try {
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    await fs.writeFile(rolloutPath, [
      JSON.stringify({ timestamp: '2026-05-08T17:01:41.000Z', type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        timestamp: '2026-05-08T17:01:42.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '晚上好呀 你困吗' }] }
      }),
      JSON.stringify({
        timestamp: '2026-05-08T17:01:43.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '晚上好，我不困，随时在。' }] }
      })
    ].join('\n'));

    const reader = createSessionMessageReader({
      readDeletedMessageIds: async () => new Set(),
      readDesktopThread: async () => {
        const error = new Error('thread not loaded: session-1');
        error.statusCode = 404;
        throw error;
      },
      resolveSessionThread: async (sessionId) => ({ id: sessionId, filePath: rolloutPath })
    });

    const result = await reader.readSessionMessages('session-1');

    assert.deepEqual(
      result.messages.map((message) => [message.role, message.content, message.turnId]),
      [
        ['user', '晚上好呀 你困吗', 'turn-1'],
        ['assistant', '晚上好，我不困，随时在。', 'turn-1']
      ]
    );
    assert.equal(result.total, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('session message reader caches rollout-sourced results until mtime or deletedIds change', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-message-reader-cache-'));
  try {
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    await fs.writeFile(rolloutPath, [
      JSON.stringify({ timestamp: '2026-05-08T01:00:00.000Z', type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        timestamp: '2026-05-08T01:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
      })
    ].join('\n'));

    // Rollout files are read first now, so count full re-reads through the
    // context-state pass — it runs once per uncached read and never on a hit.
    let reads = 0;
    let deleted = new Set();
    const reader = createSessionMessageReader({
      readDeletedMessageIds: async () => deleted,
      readDesktopThread: async () => {
        const err = new Error('thread not loaded');
        err.statusCode = 404;
        throw err;
      },
      readRolloutContextState: async (filePath, sessionId) => {
        reads += 1;
        return { sessionId };
      },
      resolveSessionThread: async (sessionId) => ({ id: sessionId, filePath: rolloutPath }),
      cacheMaxEntries: 8
    });

    const first = await reader.readSessionMessages('session-1', { limit: 10 });
    assert.equal(first.messages.length, 1);
    assert.equal(reads, 1);

    // Cache hit: no further rollout read.
    const second = await reader.readSessionMessages('session-1', { limit: 10 });
    assert.deepEqual(second.messages.map((m) => m.id), first.messages.map((m) => m.id));
    assert.equal(reads, 1, 'cache hit must skip the rollout read');

    // Touch the file (mtime changes) → cache miss.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.utimes(rolloutPath, new Date(), new Date());
    await reader.readSessionMessages('session-1', { limit: 10 });
    assert.equal(reads, 2, 'mtime change must invalidate cache');

    // Same mtime, but deletedIds changed → cache miss.
    deleted = new Set(['some-deleted-id']);
    await reader.readSessionMessages('session-1', { limit: 10 });
    assert.equal(reads, 3, 'deletedIds change must invalidate cache');

    // invalidateSessionMessages clears entries.
    reader.invalidateSessionMessages('session-1');
    await reader.readSessionMessages('session-1', { limit: 10 });
    assert.equal(reads, 4, 'manual invalidate must force re-read');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('session message reader does not cache desktop-sourced threads', async () => {
  let ipcCalls = 0;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-message-reader-nocache-'));
  try {
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    await fs.writeFile(rolloutPath, '');

    const reader = createSessionMessageReader({
      readDeletedMessageIds: async () => new Set(),
      readDesktopThread: async () => {
        ipcCalls += 1;
        return {
          thread: {
            id: 'session-1',
            path: rolloutPath,
            messages: [{ id: 'm-1', role: 'user', content: 'hi', timestamp: '2026-05-08T01:00:00.000Z' }]
          }
        };
      },
      resolveSessionThread: async (sessionId) => ({ id: sessionId, filePath: rolloutPath }),
      cacheMaxEntries: 8
    });

    await reader.readSessionMessages('session-1', { limit: 10 });
    await reader.readSessionMessages('session-1', { limit: 10 });
    assert.equal(ipcCalls, 2, 'desktop-sourced threads must not be cached');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('session message reader times out slow desktop IPC and falls back to rollout', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-message-reader-timeout-'));
  try {
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    await fs.writeFile(rolloutPath, [
      JSON.stringify({ timestamp: '2026-05-08T01:00:00.000Z', type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        timestamp: '2026-05-08T01:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'from rollout' }] }
      })
    ].join('\n'));

    let ipcResolved = false;
    const reader = createSessionMessageReader({
      readDeletedMessageIds: async () => new Set(),
      readDesktopThread: () => new Promise((resolve) => {
        setTimeout(() => {
          ipcResolved = true;
          resolve({ thread: { id: 'session-1', path: rolloutPath, messages: [], turns: [] } });
        }, 2000);
      }),
      resolveSessionThread: async (sessionId) => ({ id: sessionId, filePath: rolloutPath }),
      desktopReadTimeoutMs: 30,
      cacheMaxEntries: 0
    });

    const started = Date.now();
    const result = await reader.readSessionMessages('session-1', { limit: 10 });
    const elapsed = Date.now() - started;

    assert.equal(ipcResolved, false, 'should have given up on IPC before it resolved');
    assert.ok(elapsed < 500, `expected fast fallback, took ${elapsed}ms`);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].content, 'from rollout');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('messagesFromRolloutJsonl converts proposed plan answers and hides implemented requests', () => {
  const planContent = '# 移动端计划模式测试计划\n\n## Summary\n创建一个轻量测试计划。';
  const content = [
    JSON.stringify({ timestamp: '2026-05-08T18:29:01.775Z', type: 'turn_context', payload: { turn_id: 'turn-1' } }),
    JSON.stringify({
      timestamp: '2026-05-08T18:29:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '/plan 测试计划卡片' }] }
    }),
    JSON.stringify({
      timestamp: '2026-05-08T18:29:11.962Z',
      type: 'response_item',
      payload: {
        id: 'assistant-plan-1',
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: `<proposed_plan>\n${planContent}\n</proposed_plan>` }]
      }
    }),
    JSON.stringify({ timestamp: '2026-05-08T18:30:01.000Z', type: 'turn_context', payload: { turn_id: 'turn-2' } }),
    JSON.stringify({
      timestamp: '2026-05-08T18:30:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `PLEASE IMPLEMENT THIS PLAN:\n${planContent}` }] }
    })
  ].join('\n');

  const result = messagesFromRolloutJsonl(content, 'session-1');

  assert.deepEqual(result.messages.map((message) => message.role), ['user', 'plan', 'user']);
  assert.equal(result.messages[1].title, '移动端计划模式测试计划');
  assert.equal(result.messages[2].content, '执行计划');
});

test('messagesFromRolloutJsonl keeps final answers, folds commentary into activities, drops injected blocks', () => {
  const parsed = messagesFromRolloutJsonl([
    JSON.stringify({ timestamp: '2026-08-31T01:00:00.000Z', type: 'turn_context', payload: { turn_id: 'turn-1' } }),
    JSON.stringify({
      timestamp: '2026-08-31T01:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>…</recommended_plugins>' }] }
    }),
    JSON.stringify({
      timestamp: '2026-08-31T01:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] }
    }),
    JSON.stringify({
      timestamp: '2026-08-31T01:00:03.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', phase: 'commentary', id: 'msg-c', content: [{ type: 'output_text', text: '我先跑一遍静态检查。' }] }
    }),
    JSON.stringify({
      timestamp: '2026-08-31T01:00:04.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '检查通过。' }] }
    })
  ].join('\n'), 'session-1');

  assert.deepEqual(
    parsed.messages.map((message) => [message.role, message.content]),
    [['user', '继续'], ['assistant', '检查通过。']]
  );
  assert.deepEqual(
    parsed.activities.map((item) => [item.turnId, item.activity.kind, item.activity.label]),
    [['turn-1', 'agent_message', '我先跑一遍静态检查。']]
  );
});

test('session message reader prefers the rollout file over a desktop read', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-rollout-first-'));
  try {
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    await fs.writeFile(rolloutPath, [
      JSON.stringify({ timestamp: '2026-08-31T01:00:00.000Z', type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        timestamp: '2026-08-31T01:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '来自 rollout' }] }
      })
    ].join('\n'));

    let desktopReads = 0;
    const reader = createSessionMessageReader({
      readDeletedMessageIds: async () => new Set(),
      readDesktopThread: async () => {
        desktopReads += 1;
        return { thread: { id: 'session-1', path: rolloutPath, messages: [{ id: 'd-1', role: 'user', content: '来自桌面' }] } };
      },
      resolveSessionThread: async (sessionId) => ({ id: sessionId, filePath: rolloutPath }),
      cacheMaxEntries: 0
    });

    const result = await reader.readSessionMessages('session-1', { limit: 10 });

    assert.deepEqual(result.messages.map((message) => message.content), ['来自 rollout']);
    assert.equal(desktopReads, 0, 'a readable rollout file must not spawn a desktop read');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rollout parsing yields command steps in one pass and skips the extra file reads', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-single-pass-'));
  try {
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    await fs.writeFile(rolloutPath, [
      JSON.stringify({ timestamp: '2026-09-01T01:00:00.000Z', type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        timestamp: '2026-09-01T01:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '看一下状态' }] }
      }),
      JSON.stringify({
        timestamp: '2026-09-01T01:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          status: 'completed',
          call_id: 'call-1',
          input: 'const r = await tools.exec_command({cmd:"git status --short"});'
        }
      }),
      JSON.stringify({
        timestamp: '2026-09-01T01:00:03.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'Output:\n M server/x.js' }
      }),
      JSON.stringify({
        timestamp: '2026-09-01T01:00:04.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '干净的' }] }
      })
    ].join('\n'));

    let rawReads = 0;
    let collabReads = 0;
    const reader = createSessionMessageReader({
      readDeletedMessageIds: async () => new Set(),
      readDesktopThread: async () => {
        const error = new Error('thread not loaded');
        error.statusCode = 404;
        throw error;
      },
      resolveSessionThread: async (sessionId) => ({ id: sessionId, filePath: rolloutPath }),
      readRawSessionActivities: async () => { rawReads += 1; return []; },
      readDesktopCollabActivities: async () => { collabReads += 1; return []; },
      cacheMaxEntries: 0
    });

    const result = await reader.readSessionMessages('session-1', { limit: 50, includeActivity: true });

    assert.deepEqual(result.messages.map((m) => m.role), ['user', 'activity', 'assistant']);
    const steps = result.messages[1].activities;
    assert.deepEqual(steps.map((s) => s.kind), ['command_execution']);
    assert.equal(steps[0].command, 'git status --short');
    assert.match(steps[0].output, /server\/x\.js/);
    assert.equal(rawReads, 0, 'rollout-sourced threads must not re-read the file for raw activities');
    assert.equal(collabReads, 0, 'rollout-sourced threads must not re-read the file for collab activities');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
