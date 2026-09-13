function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function userMessageIdentity(value) {
  const text = normalizeText(value);
  if (!text) {
    return '';
  }
  const withoutPreviewImages = text.replace(/!\[[^\]]*]\(([^)]+)\)/g, '').trim();
  return normalizeText(withoutPreviewImages || text);
}

function runKeys(run = {}) {
  return [
    run.turnId,
    run.clientTurnId,
    run.sessionId,
    run.previousSessionId,
    run.draftSessionId
  ].filter(Boolean);
}

function hasAssistantAfterUser(messages = [], userMessage = '') {
  const expected = userMessageIdentity(userMessage);
  if (!expected) {
    return false;
  }
  let matchedUser = false;
  for (const message of messages) {
    if (message?.role === 'user' && userMessageIdentity(message.content) === expected) {
      matchedUser = true;
      continue;
    }
    if (matchedUser && message?.role === 'assistant' && normalizeText(message.content)) {
      return true;
    }
  }
  return false;
}

export function createDesktopTurnMonitor({
  readSessionMessages,
  refreshCodexCache,
  rememberTurn,
  broadcast,
  scheduleAutoNameCompletedSession,
  now = () => new Date().toISOString(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  pollDelays = [700, 1000, 1500, 2500, 4000, 6500, 10000, 15000, 22000, 30000],
  maxPolls = 80,
  logger = console,
  onRunFinished = () => {}
} = {}) {
  const runsByKey = new Map();
  const activeRuns = new Set();

  function rememberForRun(run, patch) {
    const ids = [run.turnId, run.clientTurnId].filter(Boolean);
    for (const turnId of [...new Set(ids)]) {
      rememberTurn?.(turnId, {
        projectId: run.projectId,
        sessionId: run.sessionId,
        previousSessionId: run.previousSessionId || null,
        source: 'desktop-ipc',
        ...patch
      });
    }
  }

  function publicRun(run) {
    return {
      source: 'desktop-ipc',
      projectId: run.projectId,
      sessionId: run.sessionId,
      previousSessionId: run.previousSessionId || null,
      turnId: run.turnId,
      clientTurnId: run.clientTurnId || null,
      startedAt: run.startedAt,
      status: run.status,
      steerable: false
    };
  }

  function registerRun(run) {
    activeRuns.add(run);
    for (const key of runKeys(run)) {
      runsByKey.set(key, run);
    }
  }

  function unregisterRun(run) {
    activeRuns.delete(run);
    for (const key of runKeys(run)) {
      if (runsByKey.get(key) === run) {
        runsByKey.delete(key);
      }
    }
    if (run.timer) {
      clearTimer(run.timer);
      run.timer = null;
    }
  }

  async function completeRun(run, result = {}) {
    if (run.status !== 'running') {
      return;
    }
    run.status = 'completed';
    unregisterRun(run);
    const completedAt = now();
    rememberForRun(run, {
      status: 'completed',
      label: '任务已完成',
      completedAt,
      hadAssistantText: true,
      context: result.context || null
    });
    broadcast?.({
      type: 'chat-complete',
      source: 'desktop-ipc',
      projectId: run.projectId,
      sessionId: run.sessionId,
      previousSessionId: run.previousSessionId || undefined,
      turnId: run.turnId,
      clientTurnId: run.clientTurnId || undefined,
      hadAssistantText: true,
      context: result.context || null,
      startedAt: run.startedAt,
      completedAt
    });
    try {
      const snapshot = await refreshCodexCache?.();
      if (snapshot) {
        broadcast?.({
          type: 'sync-complete',
          syncedAt: snapshot.syncedAt,
          projects: snapshot.projects,
          pinFolders: snapshot.pinFolders
        });
      }
    } catch (error) {
      logger?.warn?.('[desktop-ipc] sync refresh after monitor completion failed:', error.message);
    }
    scheduleAutoNameCompletedSession?.({
      sessionId: run.sessionId,
      turnId: run.clientTurnId || run.turnId,
      userMessage: run.userMessage
    });
    try {
      onRunFinished(publicRun(run));
    } catch (error) {
      logger?.warn?.('[desktop-ipc] onRunFinished hook failed:', error.message);
    }
  }

  async function failRun(run, error) {
    if (run.status !== 'running') {
      return;
    }
    run.status = 'failed';
    unregisterRun(run);
    const completedAt = now();
    const detail = error?.message || '桌面端执行状态同步超时';
    rememberForRun(run, {
      status: 'failed',
      label: '任务失败',
      error: detail,
      completedAt
    });
    broadcast?.({
      type: 'chat-error',
      source: 'desktop-ipc',
      projectId: run.projectId,
      sessionId: run.sessionId,
      previousSessionId: run.previousSessionId || undefined,
      turnId: run.turnId,
      clientTurnId: run.clientTurnId || undefined,
      error: detail,
      completedAt
    });
    try {
      onRunFinished(publicRun(run));
    } catch (hookError) {
      logger?.warn?.('[desktop-ipc] onRunFinished hook failed:', hookError.message);
    }
  }

  async function pollRun(run) {
    if (run.status !== 'running') {
      return;
    }
    run.pollCount += 1;
    try {
      const result = await readSessionMessages(run.sessionId, { limit: 120, includeActivity: false });
      if (hasAssistantAfterUser(result?.messages || [], run.userMessage)) {
        await completeRun(run, result);
        return;
      }
    } catch (error) {
      logger?.warn?.('[desktop-ipc] monitor read failed:', error.message);
    }

    if (run.pollCount >= maxPolls) {
      await failRun(run, new Error('桌面端回复同步超时，请手动刷新会话。'));
      return;
    }
    schedulePoll(run);
  }

  function schedulePoll(run) {
    const delay = pollDelays[Math.min(run.pollCount, pollDelays.length - 1)] || 1000;
    run.timer = setTimer(() => pollRun(run), delay);
    if (typeof run.timer?.unref === 'function') {
      run.timer.unref();
    }
  }

  function startRun(payload = {}) {
    if (!payload.sessionId || !payload.turnId || !payload.userMessage) {
      return null;
    }
    const existing = runsByKey.get(payload.turnId) || runsByKey.get(payload.clientTurnId);
    if (existing) {
      unregisterRun(existing);
    }
    const startedAt = payload.startedAt || now();
    const run = {
      source: 'desktop-ipc',
      projectId: payload.projectId || null,
      sessionId: payload.sessionId,
      previousSessionId: payload.previousSessionId || null,
      draftSessionId: payload.draftSessionId || null,
      turnId: payload.turnId,
      clientTurnId: payload.clientTurnId || payload.turnId,
      userMessage: payload.userMessage,
      startedAt,
      status: 'running',
      pollCount: 0,
      timer: null
    };
    registerRun(run);
    rememberForRun(run, {
      status: 'running',
      label: '已交给桌面端处理',
      startedAt
    });
    broadcast?.({
      type: 'status-update',
      source: 'desktop-ipc',
      projectId: run.projectId,
      sessionId: run.sessionId,
      previousSessionId: run.previousSessionId || undefined,
      turnId: run.turnId,
      clientTurnId: run.clientTurnId || undefined,
      kind: 'turn',
      status: 'running',
      label: '已交给桌面端处理',
      detail: '',
      startedAt,
      timestamp: now()
    });
    schedulePoll(run);
    return run;
  }

  function abortRun(identifier) {
    const key = String(identifier || '').trim();
    const run = runsByKey.get(key);
    if (!run || run.status !== 'running') {
      return false;
    }
    run.status = 'aborted';
    unregisterRun(run);
    const completedAt = now();
    rememberForRun(run, {
      status: 'aborted',
      label: '已中止',
      completedAt
    });
    broadcast?.({
      type: 'chat-aborted',
      source: 'desktop-ipc',
      projectId: run.projectId,
      sessionId: run.sessionId,
      previousSessionId: run.previousSessionId || undefined,
      turnId: run.turnId,
      clientTurnId: run.clientTurnId || undefined,
      completedAt,
      timestamp: completedAt
    });
    try {
      onRunFinished(publicRun(run));
    } catch (error) {
      logger?.warn?.('[desktop-ipc] onRunFinished hook failed:', error.message);
    }
    return true;
  }

  function getRun(identifier) {
    const key = String(identifier || '').trim();
    const run = runsByKey.get(key);
    if (!run || run.status !== 'running') {
      return null;
    }
    return publicRun(run);
  }

  function getActiveRuns() {
    return [...activeRuns].filter((run) => run.status === 'running').map(publicRun);
  }

  function hasActiveWork(sessionId) {
    const id = String(sessionId || '').trim();
    return Boolean(id && runsByKey.has(id));
  }

  return {
    abortRun,
    getActiveRuns,
    getRun,
    hasActiveWork,
    startRun
  };
}
