import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatService } from './chat-service.js';

function makeChatService(overrides = {}) {
  const broadcasts = [];
  const service = createChatService({
    imagePromptState: '.codexmobile/test-state/codexmobile-chat-service-test.json',
    getProject: () => ({ id: 'project-1', name: 'Project', path: '/tmp/project', projectless: false }),
    getSession: () => ({ id: 'thread-1', projectId: 'project-1' }),
    getCacheSnapshot: () => ({ config: { skills: [], model: 'gpt-5.5' } }),
    getDesktopBridgeStatus: async () => ({ strict: false, connected: true, mode: 'headless-local', reason: null }),
    listProjectSessions: () => [],
    readSessionMessages: async () => ({ messages: [] }),
    refreshCodexCache: async () => ({ syncedAt: 'now', projects: [] }),
    renameSession: async () => null,
    broadcast: (payload) => broadcasts.push(payload),
    runCodexTurn: async (payload, emit) => {
      emit({ type: 'chat-complete', sessionId: payload.sessionId || 'thread-1', turnId: payload.turnId });
      return payload.sessionId || 'thread-1';
    },
    steerCodexTurn: async () => ({ accepted: true, delivery: 'steered', sessionId: 'thread-1', turnId: 'active-turn' }),
    setDesktopFollowerCollaborationMode: async () => ({ ok: true }),
    abortCodexTurn: () => true,
    getActiveRuns: () => [],
    runImageTurn: async () => 'thread-1',
    isImageRequest: () => false,
    analyzeImageIntent: () => ({ intent: null, confidence: 'none', reason: 'test-default' }),
    useLegacyImageGenerator: () => true,
    maybeAutoNameSession: async () => false,
    registerProjectlessThread: async () => null,
    registerMobileSession: async () => null,
    rememberLiveSession: () => null,
    desktopOwnerRetryDelays: [],
    ...overrides
  });
  return { service, broadcasts };
}

async function flushQueuedWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('sendChat starts a headless local turn when no desktop bridge is required', async () => {
  let runPayload = null;
  const { service, broadcasts } = makeChatService({
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit({ type: 'thread-started', sessionId: 'headless-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId });
      emit({ type: 'chat-complete', sessionId: 'headless-thread-1', previousSessionId: payload.draftSessionId, turnId: payload.turnId });
      return 'headless-thread-1';
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    draftSessionId: 'draft-project-1-1',
    clientTurnId: 'client-turn',
    message: '桌面端没开也跑一下'
  });
  await flushQueuedWork();

  assert.equal(result.accepted, true);
  assert.equal(result.delivery, 'started');
  assert.equal(result.desktopBridge.mode, 'headless-local');
  assert.equal(runPayload.draftSessionId, 'draft-project-1-1');
  assert.match(runPayload.message, /桌面端没开也跑一下/);
  assert.equal(broadcasts.some((payload) => payload.type === 'user-message'), true);
  assert.equal(broadcasts.find((payload) => payload.type === 'thread-started')?.source, 'headless-local');
});

test('sendChat sends existing desktop-ipc threads through the desktop follower bridge', async () => {
  let started = null;
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }),
    startDesktopFollowerTurn: async (conversationId, params) => {
      started = { conversationId, params };
      return { result: { turn: { id: 'desktop-turn-1' } } };
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '从手机发到桌面已有线程'
  });

  assert.equal(result.delivery, 'started');
  assert.equal(result.sessionId, 'thread-1');
  assert.equal(result.turnId, 'desktop-turn-1');
  assert.equal(started.conversationId, 'thread-1');
  assert.equal(started.params.input.at(-1).type, 'text');
  assert.equal(started.params.input.at(-1).text, '从手机发到桌面已有线程');
});

test('sendChat reuses a mobile-only session for legacy image turns', async () => {
  let imagePayload = null;
  const { service } = makeChatService({
    getSession: () => ({ id: 'mobile-only-1', projectId: 'project-1', mobileOnly: true }),
    isImageRequest: () => true,
    analyzeImageIntent: () => ({ intent: 'generate', confidence: 'high', reason: 'test-image' }),
    runImageTurn: async (payload) => {
      imagePayload = payload;
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'mobile-only-1',
    clientTurnId: 'image-turn-1',
    message: 'generate image of a small robot',
    imageMode: 'force'
  });
  await flushQueuedWork();

  assert.equal(result.mode, 'image');
  assert.equal(result.sessionId, 'mobile-only-1');
  assert.equal(imagePayload.sessionId, 'mobile-only-1');
  assert.equal(imagePayload.previousSessionId, 'mobile-only-1');
});

test('sendChat asks for confirmation on high-confidence image intent', async () => {
  const { service } = makeChatService({
    analyzeImageIntent: () => ({ intent: 'generate', confidence: 'high', reason: 'explicit-generate' })
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'high-image-turn',
    message: '画一张小机器人的图片'
  });

  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.confirmationType, 'image-intent');
  assert.equal(result.intent, 'generate');
  assert.equal(result.reason, 'explicit-generate');
});

test('sendChat asks for confirmation on ambiguous image intent', async () => {
  const { service } = makeChatService({
    analyzeImageIntent: () => ({ intent: 'generate', confidence: 'medium', reason: 'ambiguous-visual-design' })
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'ambiguous-image-turn',
    message: '帮我设计一个 logo 方案'
  });

  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.confirmationType, 'image-intent');
  assert.equal(result.intent, 'generate');
  assert.equal(result.reason, 'ambiguous-visual-design');
});

test('sendChat respects explicit image force and skip flags', async () => {
  let imagePayload = null;
  let textPayload = null;
  const { service } = makeChatService({
    analyzeImageIntent: () => ({ intent: 'generate', confidence: 'medium', reason: 'ambiguous-visual-design' }),
    isImageRequest: () => false,
    runImageTurn: async (payload, emit) => {
      imagePayload = payload;
      emit({ type: 'chat-complete', sessionId: payload.sessionId, turnId: payload.turnId });
      return payload.sessionId;
    },
    runCodexTurn: async (payload, emit) => {
      textPayload = payload;
      emit({ type: 'chat-complete', sessionId: payload.sessionId || 'thread-1', turnId: payload.turnId });
      return payload.sessionId || 'thread-1';
    }
  });

  const forced = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '帮我设计一个 logo 方案',
    forceImage: true
  });
  assert.equal(forced.mode, 'image');
  assert.equal(imagePayload.message, '帮我设计一个 logo 方案');
  await flushQueuedWork();

  const skipped = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '帮我设计一个 logo 方案',
    skipImage: true
  });
  await flushQueuedWork();
  assert.equal(skipped.delivery, 'started');
  assert.match(textPayload.message, /logo/);
});

test('slash image command explicitly routes to image generation', async () => {
  let imagePayload = null;
  const { service } = makeChatService({
    runImageTurn: async (payload) => {
      imagePayload = payload;
      return payload.sessionId;
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    message: '/image a neon app icon'
  });

  assert.equal(result.mode, 'image');
  assert.equal(imagePayload.message, 'a neon app icon');
});

test('image continuation is limited to the current image session', async () => {
  let imagePayload = null;
  const { service } = makeChatService({
    getSession: (id) => ({ id, projectId: 'project-1' }),
    listProjectSessions: () => [
      { id: 'image-thread', summary: '生成一张图片：玻璃小屋' },
      { id: 'text-thread', summary: '普通开发对话' }
    ],
    isImageRequest: (message) => /生成一张图片/.test(String(message || '')),
    runImageTurn: async (payload, emit) => {
      imagePayload = payload;
      emit({ type: 'chat-complete', sessionId: payload.sessionId, turnId: payload.turnId });
      return payload.sessionId;
    }
  });

  const imageContinuation = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'image-thread',
    message: '继续'
  });
  assert.equal(imageContinuation.mode, 'image');
  assert.equal(imagePayload.message, '生成一张图片：玻璃小屋');
  await flushQueuedWork();

  const textContinuation = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'text-thread',
    message: '继续'
  });
  await flushQueuedWork();
  assert.equal(textContinuation.delivery, 'started');
});

test('queue drafts can be listed, deleted, restored, and steered', async () => {
  let steerPayload = null;
  const { service } = makeChatService({
    getActiveRuns: () => [{ sessionId: 'thread-1', status: 'running' }],
    steerCodexTurn: async (identifier, payload) => {
      steerPayload = { identifier, payload };
      return { sessionId: 'thread-1', turnId: 'steered-turn' };
    }
  });

  const first = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'queued-turn-1',
    message: '排队草稿 1',
    sendMode: 'queue',
    fileMentions: [{ name: 'App.jsx', path: '/repo/client/src/App.jsx' }]
  });
  const second = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'queued-turn-2',
    message: '排队草稿 2',
    sendMode: 'queue'
  });

  assert.equal(first.delivery, 'queued');
  assert.equal(second.delivery, 'queued');
  assert.deepEqual(service.listQueue({ sessionId: 'thread-1' }).drafts.map((draft) => draft.id), [
    'queued-turn-1',
    'queued-turn-2'
  ]);
  assert.equal(service.removeQueuedDraft({ sessionId: 'thread-1', draftId: 'queued-turn-2' }).text, '排队草稿 2');
  const steered = await service.steerQueuedDraft({ projectId: 'project-1', sessionId: 'thread-1', draftId: 'queued-turn-1' });
  assert.equal(steered.delivery, 'steered');
  assert.equal(steerPayload.identifier, 'thread-1');
  assert.match(steerPayload.payload.message, /引用文件路径/);
  assert.equal(await service.steerQueuedDraft({ projectId: 'project-1', sessionId: 'thread-1', draftId: 'missing' }), null);
});

test('sendChat queues start-mode messages when the conversation already has active work', async () => {
  const { service } = makeChatService({
    getActiveRuns: () => [{ sessionId: 'thread-1', status: 'running' }]
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'queued-start-turn',
    message: 'queue this behind the active turn'
  });

  assert.equal(result.delivery, 'queued');
  assert.deepEqual(service.listQueue({ sessionId: 'thread-1' }).drafts.map((draft) => draft.id), [
    'queued-start-turn'
  ]);
});

test('sendChat broadcasts queue-updated when a draft is enqueued and again when it starts running', async () => {
  let release = null;
  const blocker = new Promise((resolve) => { release = resolve; });
  let runCalls = 0;
  const { service, broadcasts } = makeChatService({
    getActiveRuns: () => (runCalls > 0 ? [{ sessionId: 'thread-1', status: 'running' }] : []),
    runCodexTurn: async (payload, emit) => {
      runCalls += 1;
      // First job blocks until we release it, so the second send is forced to
      // queue. Second job (and beyond) completes immediately.
      if (runCalls === 1) {
        await blocker;
      }
      emit({ type: 'chat-complete', sessionId: payload.sessionId || 'thread-1', turnId: payload.turnId });
      return payload.sessionId || 'thread-1';
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'first-turn',
    message: 'first'
  });
  const second = await service.sendChat({
    projectId: 'project-1',
    sessionId: 'thread-1',
    clientTurnId: 'second-turn',
    message: 'second'
  });
  assert.equal(second.delivery, 'queued');

  const enqueueEvents = broadcasts.filter((p) => p.type === 'queue-updated' && p.pendingCount === 1);
  assert.ok(enqueueEvents.length >= 1, 'expected a queue-updated broadcast on enqueue');
  assert.equal(enqueueEvents[0].sessionId, 'thread-1');

  release();
  await flushQueuedWork();
  await flushQueuedWork();

  const drainEvents = broadcasts.filter((p) => p.type === 'queue-updated' && p.pendingCount === 0 && p.running);
  assert.ok(drainEvents.length >= 1, 'expected a queue-updated broadcast when the queued job starts running');
});

test('abortChat records and broadcasts an aborted turn after backend run is gone', async () => {
  const { service, broadcasts } = makeChatService({
    abortCodexTurn: () => false
  });

  const aborted = await service.abortChat({
    sessionId: 'thread-1',
    turnId: 'client-turn-1',
    previousSessionId: 'thread-1'
  }, { remoteAddress: '127.0.0.1' });

  assert.equal(aborted, true);
  assert.equal(service.getTurn('client-turn-1').status, 'aborted');
  assert.equal(broadcasts.at(-1).type, 'chat-aborted');
  assert.equal(broadcasts.at(-1).turnId, 'client-turn-1');
});

test('sendChat runs a new draft in a picked worktree after validating it', async () => {
  let runPayload = null;
  let listCalls = 0;
  const { service } = makeChatService({
    listWorktrees: async (repoPath) => {
      listCalls += 1;
      assert.equal(repoPath, '/tmp/project');
      return { worktrees: [
        { path: '/tmp/project', branch: 'main' },
        { path: '/tmp/project-wt/feature', branch: 'feat/connection-recovery' }
      ] };
    },
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit({ type: 'chat-complete', sessionId: 'wt-thread-1', turnId: payload.turnId });
      return 'wt-thread-1';
    }
  });

  const result = await service.sendChat({
    projectId: 'project-1',
    draftSessionId: 'draft-project-1-1',
    clientTurnId: 'wt-turn',
    message: '在 worktree 里跑',
    workingDir: '/tmp/project-wt/feature'
  });
  await flushQueuedWork();

  assert.equal(result.accepted, true);
  assert.equal(runPayload.projectPath, '/tmp/project-wt/feature');
  assert.equal(listCalls, 1);
});

test('sendChat rejects a workingDir that is not a real worktree', async () => {
  const { service } = makeChatService({
    listWorktrees: async () => ({ worktrees: [{ path: '/tmp/project', branch: 'main' }] })
  });

  await assert.rejects(
    () => service.sendChat({
      projectId: 'project-1',
      draftSessionId: 'draft-project-1-1',
      clientTurnId: 'bad-wt-turn',
      message: '越权路径',
      workingDir: '/etc'
    }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test('sendChat short-circuits worktree validation when workingDir equals project root', async () => {
  let listCalls = 0;
  let runPayload = null;
  const { service } = makeChatService({
    listWorktrees: async () => { listCalls += 1; return { worktrees: [] }; },
    runCodexTurn: async (payload, emit) => {
      runPayload = payload;
      emit({ type: 'chat-complete', sessionId: 'thread-1', turnId: payload.turnId });
      return 'thread-1';
    }
  });

  await service.sendChat({
    projectId: 'project-1',
    draftSessionId: 'draft-project-1-1',
    clientTurnId: 'same-path-turn',
    message: '主仓根目录',
    workingDir: '/tmp/project'
  });
  await flushQueuedWork();

  assert.equal(listCalls, 0);
  assert.equal(runPayload.projectPath, '/tmp/project');
});

test('sendChat reports a desktop-held thread instead of a doomed background write', async () => {
  const { service } = makeChatService({
    getDesktopBridgeStatus: async () => ({
      strict: true,
      connected: true,
      mode: 'desktop-ipc',
      reason: null,
      capabilities: { sendToOpenDesktopThread: true, createThread: false, backgroundCodex: true }
    }),
    startDesktopFollowerTurn: async () => {
      const error = new Error('desktop owner did not answer');
      error.code = 'CODEXMOBILE_DESKTOP_THREAD_OWNER_UNAVAILABLE';
      throw error;
    },
    isDesktopThreadOpen: (id) => id === 'thread-1'
  });

  await assert.rejects(
    service.sendChat({ projectId: 'project-1', sessionId: 'thread-1', message: '桌面开着这条会话' }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /桌面/);
      return true;
    }
  );
});
