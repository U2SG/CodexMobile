import crypto from 'node:crypto';

const DEFAULT_MAX_RECENT_TURNS = 80;

function payloadReferencesSession(payload, sessionId) {
  return [
    payload?.sessionId,
    payload?.previousSessionId,
    payload?.draftSessionId,
    payload?.selectedSessionId
  ].some((value) => value && value === sessionId);
}

function serializeQueueJob(job) {
  return {
    id: job.draftId || job.turnId,
    turnId: job.turnId,
    projectId: job.project?.id || job.projectId || null,
    text: job.displayMessage,
    attachments: Array.isArray(job.attachments) ? job.attachments : [],
    selectedSkills: Array.isArray(job.selectedSkills) ? job.selectedSkills : [],
    fileMentions: Array.isArray(job.fileMentions) ? job.fileMentions : [],
    collaborationMode: job.collaborationMode?.mode === 'plan' ? 'plan' : null,
    createdAt: job.createdAt || new Date().toISOString(),
    sessionId: job.selectedSessionId || null,
    draftSessionId: job.draftSessionId || null
  };
}

export function createChatQueue({ maxRecentTurns = DEFAULT_MAX_RECENT_TURNS } = {}) {
  const recentTurns = new Map();
  const conversationQueues = new Map();
  const sessionQueueKeys = new Map();

  function rememberTurn(turnId, patch) {
    if (!turnId) {
      return null;
    }
    const existing = recentTurns.get(turnId) || { turnId, createdAt: new Date().toISOString() };
    const next = {
      ...existing,
      ...patch,
      turnId,
      updatedAt: new Date().toISOString()
    };
    recentTurns.set(turnId, next);

    if (recentTurns.size > maxRecentTurns) {
      const oldest = [...recentTurns.entries()].sort(
        (a, b) => new Date(a[1].updatedAt || a[1].createdAt || 0) - new Date(b[1].updatedAt || b[1].createdAt || 0)
      )[0]?.[0];
      if (oldest) {
        recentTurns.delete(oldest);
      }
    }
    return next;
  }

  function rememberTurnEvent(payload) {
    if (!payload?.turnId) {
      return;
    }

    const patch = {
      projectId: payload.projectId,
      sessionId: payload.sessionId || undefined,
      previousSessionId: payload.previousSessionId || undefined
    };

    if (payload.type === 'chat-started') {
      patch.status = 'running';
      patch.startedAt = payload.startedAt || new Date().toISOString();
      patch.label = '正在思考';
    } else if (payload.type === 'thread-started') {
      patch.status = 'running';
      patch.label = '正在思考';
    } else if (payload.type === 'status-update') {
      patch.status = payload.status || 'running';
      patch.kind = payload.kind || undefined;
      patch.label = payload.label || undefined;
      patch.detail = payload.detail || undefined;
    } else if (payload.type === 'assistant-update') {
      patch.status = 'running';
      patch.hadAssistantText = true;
      patch.assistantPreview = payload.content || '';
      patch.messageId = payload.messageId || undefined;
      patch.label = '正在回复';
    } else if (payload.type === 'context-status-update') {
      patch.status = payload.status || 'running';
      patch.context = payload;
      patch.label = '背景信息已同步';
    } else if (payload.type === 'chat-complete') {
      patch.status = 'completed';
      patch.completedAt = payload.completedAt || new Date().toISOString();
      patch.hadAssistantText = Boolean(payload.hadAssistantText);
      patch.usage = payload.usage || null;
      patch.context = payload.context || null;
      patch.label = '任务已完成';
    } else if (payload.type === 'chat-error') {
      patch.status = 'failed';
      patch.error = payload.error || '任务失败';
      patch.label = '任务失败';
    } else if (payload.type === 'chat-aborted') {
      patch.status = 'aborted';
      patch.label = '已中止';
    } else {
      return;
    }

    if (payload.startedAt) {
      patch.startedAt = payload.startedAt;
    }
    if (payload.completedAt) {
      patch.completedAt = payload.completedAt;
    }
    if (payload.durationMs) {
      patch.durationMs = payload.durationMs;
    }

    rememberTurn(payload.turnId, patch);
  }

  function rememberConversationAlias(queueKey, sessionId) {
    if (queueKey && sessionId) {
      sessionQueueKeys.set(sessionId, queueKey);
    }
  }

  function resolveConversationKey(...ids) {
    for (const id of ids) {
      if (id && sessionQueueKeys.has(id)) {
        return sessionQueueKeys.get(id);
      }
    }
    const queueKey = ids.find(Boolean) || crypto.randomUUID();
    for (const id of ids) {
      rememberConversationAlias(queueKey, id);
    }
    return queueKey;
  }

  function getConversationQueue(queueKey) {
    if (!conversationQueues.has(queueKey)) {
      conversationQueues.set(queueKey, {
        sessionId: null,
        running: false,
        jobs: []
      });
    }
    return conversationQueues.get(queueKey);
  }

  function queueForRequest({ sessionId = '', draftSessionId = '' } = {}) {
    const queueKey = resolveConversationKey(
      String(sessionId || '').trim() || null,
      String(draftSessionId || '').trim() || null
    );
    return { queueKey, state: getConversationQueue(queueKey) };
  }

  function listQueue(query = {}) {
    const { state } = queueForRequest(query);
    return {
      drafts: state.jobs.map(serializeQueueJob),
      running: state.running
    };
  }

  function removeQueuedDraft(query = {}) {
    const draftId = String(query.draftId || '').trim();
    if (!draftId) {
      return null;
    }
    const { state } = queueForRequest(query);
    const index = state.jobs.findIndex((job) => (job.draftId || job.turnId) === draftId);
    if (index < 0) {
      return null;
    }
    const [removed] = state.jobs.splice(index, 1);
    return serializeQueueJob(removed);
  }

  function peekQueuedDraft(query = {}) {
    const draftId = String(query.draftId || '').trim();
    if (!draftId) {
      return null;
    }
    const { state } = queueForRequest(query);
    const found = state.jobs.find((job) => (job.draftId || job.turnId) === draftId);
    if (!found) {
      return null;
    }
    return serializeQueueJob(found);
  }

  function restoreQueuedDraft(query = {}) {
    return removeQueuedDraft(query);
  }

  function enqueueJob(job, { forceQueued = false } = {}) {
    const state = getConversationQueue(job.queueKey);
    rememberConversationAlias(job.queueKey, job.selectedSessionId);
    rememberConversationAlias(job.queueKey, job.draftSessionId);

    const queued = forceQueued || state.running || state.jobs.length > 0;
    state.jobs.push({
      ...job,
      draftId: job.draftId || job.turnId,
      createdAt: job.createdAt || new Date().toISOString()
    });
    return { queued, state };
  }

  function sessionHasActiveWork(sessionId, activeRuns = []) {
    if (!sessionId) {
      return false;
    }
    if (activeRuns.some((run) => payloadReferencesSession(run, sessionId))) {
      return true;
    }

    for (const turn of recentTurns.values()) {
      if (
        (turn.status === 'accepted' || turn.status === 'queued' || turn.status === 'running') &&
        payloadReferencesSession(turn, sessionId)
      ) {
        return true;
      }
    }

    for (const state of conversationQueues.values()) {
      if (state.running && state.sessionId === sessionId) {
        return true;
      }
      if (state.jobs.some((job) => payloadReferencesSession(job, sessionId))) {
        return true;
      }
    }

    return false;
  }

  return {
    enqueueJob,
    getConversationQueue,
    getTurn(turnId) {
      return recentTurns.get(turnId) || null;
    },
    listQueue,
    peekQueuedDraft,
    rememberConversationAlias,
    rememberTurn,
    rememberTurnEvent,
    removeQueuedDraft,
    resolveConversationKey,
    restoreQueuedDraft,
    sessionHasActiveWork
  };
}
