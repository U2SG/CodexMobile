import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import readline from 'node:readline';
import { readDesktopThread as defaultReadDesktopThread } from './codex-app-server.js';
import {
  applyRolloutCommandOutput,
  readDesktopCollabActivities as defaultReadDesktopCollabActivities,
  readRawSessionActivities as defaultReadRawSessionActivities,
  rolloutCommandActivity
} from './desktop-activity-parser.js';
import {
  commentaryActivity,
  extractProposedPlanContent,
  implementedPlanContentFromMessage,
  isCodexSystemNoiseBlock,
  isCommentaryPhase,
  messagesFromDesktopThread as defaultMessagesFromDesktopThread,
  planMessageFromContent,
  planRequestMessageFromContent,
  removeFallbackActivitiesCoveredByRaw as defaultRemoveFallbackActivitiesCoveredByRaw,
  sanitizeVisibleUserMessage,
  sortDesktopActivitySteps as defaultSortDesktopActivitySteps,
  upsertDesktopActivity as defaultUpsertDesktopActivity
} from './desktop-thread-projector.js';
import {
  filterDeletedMessages as defaultFilterDeletedMessages,
  readDeletedMessageIds as defaultReadDeletedMessageIds
} from './session-local-state.js';

const ROLLOUT_CONTEXT_READ_BYTES = Math.max(
  64 * 1024,
  Number(process.env.CODEXMOBILE_ROLLOUT_CONTEXT_READ_BYTES) || 1024 * 1024
);
const GUIDED_USER_LABEL = '已引导对话';

function guidedUserMetadata(enabled) {
  return enabled
    ? { guided: true, guideLabel: GUIDED_USER_LABEL, kind: 'guided_user' }
    : {};
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function epochSecondsFromIso(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function responseMessageText(content) {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => item?.text || item?.content || '')
    .filter(Boolean)
    .join('')
    .trim();
}

function ensureRolloutTurn(turns, sessionId, timestamp) {
  if (turns.length) {
    return turns.at(-1);
  }
  const turn = {
    id: `${sessionId}-turn-1`,
    startedAt: epochSecondsFromIso(timestamp)
  };
  turns.push(turn);
  return turn;
}

export function messagesFromRolloutJsonl(content, sessionId) {
  const messages = [];
  const turns = [];
  const activities = [];
  const commandCallsById = new Map();
  const implementedPlanContents = new Set();
  const userCountsByTurn = new Map();
  const lines = String(content || '').split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = entry.timestamp || new Date().toISOString();
    if (entry.type === 'turn_context') {
      turns.push({
        id: entry.payload?.turn_id || `${sessionId}-turn-${turns.length + 1}`,
        startedAt: epochSecondsFromIso(timestamp)
      });
      continue;
    }
    if (entry.type !== 'response_item') {
      continue;
    }
    // Command steps come out of the same pass as the messages: walking a
    // multi-MB rollout three times (messages, then raw activities, then collab
    // activities) cost ~350ms of the ~480ms a 13MB session took to open, and
    // the two extra passes returned nothing at all on 0.149 rollouts.
    const payloadType = entry.payload?.type;
    if (payloadType === 'custom_tool_call' || payloadType === 'function_call') {
      const commandTurn = ensureRolloutTurn(turns, sessionId, timestamp);
      const activity = rolloutCommandActivity(entry.payload, {
        timestamp,
        turnId: commandTurn.id,
        idSuffix: entry.payload.call_id || `${activities.length + 1}`
      });
      if (activity) {
        const segmentIndex = Math.max(0, (userCountsByTurn.get(commandTurn.id) || 0) - 1);
        const item = { turnId: commandTurn.id, segmentIndex, activity };
        activities.push(item);
        if (entry.payload.call_id) {
          commandCallsById.set(entry.payload.call_id, activity);
        }
      }
      continue;
    }
    if (payloadType === 'custom_tool_call_output' || payloadType === 'function_call_output') {
      applyRolloutCommandOutput(commandCallsById.get(entry.payload.call_id), entry.payload);
      continue;
    }
    if (payloadType !== 'message') {
      continue;
    }
    const role = entry.payload.role;
    if (role !== 'user' && role !== 'assistant') {
      continue;
    }
    const contentText = responseMessageText(entry.payload.content);
    if (!contentText) {
      continue;
    }
    if (role === 'user' && isCodexSystemNoiseBlock(contentText)) {
      continue;
    }
    if (role === 'assistant' && isCommentaryPhase(entry.payload)) {
      const commentaryTurn = ensureRolloutTurn(turns, sessionId, timestamp);
      const activity = commentaryActivity(contentText, {
        id: entry.payload.id ? `${entry.payload.id}-commentary` : `${commentaryTurn.id}-commentary-${activities.length + 1}`,
        turnId: commentaryTurn.id,
        timestamp
      });
      if (activity) {
        activities.push({ turnId: commentaryTurn.id, activity });
      }
      continue;
    }
    const implementedPlanContent = role === 'user' ? implementedPlanContentFromMessage(contentText) : '';
    if (implementedPlanContent) {
      implementedPlanContents.add(implementedPlanContent.replace(/\s+/g, ' ').trim());
    }
    const turn = ensureRolloutTurn(turns, sessionId, timestamp);
    let userIndex = -1;
    if (role === 'user') {
      userIndex = userCountsByTurn.get(turn.id) || 0;
      userCountsByTurn.set(turn.id, userIndex + 1);
    }
    if (role === 'assistant') {
      const proposedPlan = extractProposedPlanContent(contentText);
      if (proposedPlan) {
        const baseId = entry.payload.id || `${turn.id}-assistant-${messages.length + 1}`;
        const planMessage = planMessageFromContent({
          id: `${baseId}-plan`,
          content: proposedPlan,
          timestamp,
          turnId: turn.id,
          sessionId
        });
        const requestMessage = planRequestMessageFromContent({
          id: `${baseId}-plan-request`,
          requestId: `implement-plan:${turn.id}`,
          content: proposedPlan,
          timestamp,
          turnId: turn.id,
          sessionId
        });
        if (planMessage) messages.push(planMessage);
        if (requestMessage) messages.push(requestMessage);
        continue;
      }
    }
    messages.push({
      id: entry.payload.id || `${turn.id}-${role}-${messages.length + 1}`,
      role,
      content: role === 'user' ? sanitizeVisibleUserMessage(contentText) : contentText,
      ...(role === 'user' ? guidedUserMetadata(userIndex > 0) : {}),
      timestamp,
      turnId: turn.id,
      sessionId
    });
  }

  const filteredMessages = implementedPlanContents.size
    ? messages.filter((message) => {
      if (message.role !== 'plan_request') return true;
      const planContent = String(message.planImplementation?.planContent || '').replace(/\s+/g, ' ').trim();
      return !implementedPlanContents.has(planContent);
    })
    : messages;

  return { messages: filteredMessages, turns, activities };
}

async function readRolloutThreadFromFile(filePath, sessionId) {
  if (!filePath) {
    return null;
  }
  const content = await fs.readFile(filePath, 'utf8');
  const parsed = messagesFromRolloutJsonl(content, sessionId);
  return {
    id: sessionId,
    path: filePath,
    turns: parsed.turns,
    messages: parsed.messages,
    activities: parsed.activities
  };
}

function desktopThreadHasMessages(thread) {
  if (Array.isArray(thread?.messages) && thread.messages.length > 0) {
    return true;
  }
  return (Array.isArray(thread?.turns) ? thread.turns : []).some((turn) =>
    Array.isArray(turn?.items) && turn.items.length > 0
  );
}

function canFallbackToRollout(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    error?.statusCode === 404 ||
    error?.code === 'CODEXMOBILE_DESKTOP_BRIDGE_UNAVAILABLE' ||
    message.includes('thread not loaded') ||
    message.includes('desktop thread not found')
  );
}

export function publicContextState(state = {}, configContext = {}) {
  const contextWindow = state.contextWindow || configContext.modelContextWindow || null;
  const inputTokens = state.inputTokens || null;
  const autoCompactLimit = configContext.autoCompactTokenLimit || null;
  const percent =
    inputTokens && contextWindow
      ? Math.max(0, Math.min(100, Math.round((inputTokens / contextWindow) * 1000) / 10))
      : null;
  const compactDetected = Boolean(state.autoCompactDetected);
  return {
    sessionId: state.sessionId || null,
    model: state.model || null,
    inputTokens,
    totalTokens: state.totalTokens || null,
    contextWindow,
    percent,
    lastTokenUsage: state.lastTokenUsage || null,
    totalTokenUsage: state.totalTokenUsage || null,
    updatedAt: state.updatedAt || null,
    autoCompact: {
      enabled: Boolean(autoCompactLimit || configContext.autoCompactEnabled),
      tokenLimit: autoCompactLimit,
      detected: compactDetected,
      status: compactDetected ? 'detected' : (autoCompactLimit || configContext.autoCompactEnabled) ? 'watching' : 'unknown',
      lastCompactedAt: state.autoCompactLastAt || null,
      reason: state.autoCompactReason || ''
    }
  };
}

export function publicRuntimeState(runtime = null, sessionId = '') {
  if (runtime?.status !== 'running') {
    return null;
  }
  return {
    status: 'running',
    source: runtime.source || 'desktop-thread',
    sessionId: runtime.sessionId || sessionId || null,
    turnId: runtime.turnId || null,
    startedAt: runtime.startedAt || null,
    updatedAt: runtime.updatedAt || null,
    steerable: runtime.steerable === true
  };
}

function tokenUsageFromPayload(payload) {
  const info = payload?.info && typeof payload.info === 'object' ? payload.info : {};
  const last = info.last_token_usage && typeof info.last_token_usage === 'object' ? info.last_token_usage : {};
  const total = info.total_token_usage && typeof info.total_token_usage === 'object' ? info.total_token_usage : {};
  return {
    inputTokens: positiveNumber(last.input_tokens ?? total.input_tokens),
    totalTokens: positiveNumber(total.total_tokens ?? last.total_tokens),
    contextWindow: positiveNumber(info.model_context_window ?? payload?.model_context_window),
    lastTokenUsage: last,
    totalTokenUsage: total
  };
}

function isoFromEpochValue(value, fallback = null) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000).toISOString();
  }
  return fallback;
}

function markRuntimeRunning(state, { turnId, timestamp, startedAt = null } = {}) {
  const id = String(turnId || '').trim();
  if (!id) {
    return;
  }
  const startedAtIso = isoFromEpochValue(startedAt, timestamp || new Date().toISOString());
  state.runtime = {
    status: 'running',
    source: 'desktop-thread',
    sessionId: state.sessionId || null,
    turnId: id,
    startedAt: startedAtIso,
    updatedAt: timestamp || startedAtIso || new Date().toISOString(),
    steerable: false
  };
}

function clearRuntimeForTurn(state, turnId) {
  if (!state.runtime) {
    return;
  }
  const id = String(turnId || '').trim();
  if (!id || state.runtime.turnId === id) {
    state.runtime = null;
  }
}

function applyContextEntry(state, entry, sessionId) {
  const payload = entry?.payload || {};
  const timestamp = entry?.timestamp || new Date().toISOString();
  const type = payload.type || '';

  if (entry.type === 'turn_context') {
    markRuntimeRunning(state, { turnId: payload.turn_id, timestamp });
    const summary = String(payload.summary || '').trim();
    if (summary && summary !== 'none') {
      state.autoCompactDetected = true;
      state.autoCompactLastAt = timestamp;
      state.autoCompactReason = '会话已带摘要继续';
    }
    if (payload.model) state.model = payload.model;
    state.updatedAt = timestamp;
    return;
  }

  if (
    entry.type === 'response_item' &&
    payload.type === 'message' &&
    payload.role === 'assistant' &&
    payload.phase !== 'commentary'
  ) {
    clearRuntimeForTurn(state, state.runtime?.turnId);
    state.updatedAt = timestamp;
    return;
  }

  if (entry.type === 'compacted') {
    state.autoCompactDetected = true;
    state.autoCompactLastAt = timestamp;
    state.autoCompactReason = '上下文已自动压缩';
    state.updatedAt = timestamp;
    return;
  }

  if (entry.type !== 'event_msg') {
    return;
  }

  if (type === 'task_started') {
    markRuntimeRunning(state, { turnId: payload.turn_id, timestamp, startedAt: payload.started_at });
    state.contextWindow = positiveNumber(payload.model_context_window) || state.contextWindow || null;
    state.updatedAt = timestamp;
    return;
  }

  if (/^task_(complete|failed|aborted|cancelled|canceled)$/.test(type) || /^turn_(complete|failed|aborted|cancelled|canceled)$/.test(type)) {
    clearRuntimeForTurn(state, payload.turn_id);
    state.updatedAt = timestamp;
    return;
  }

  if (type !== 'token_count') {
    return;
  }

  const usage = tokenUsageFromPayload(payload);
  const previousInputTokens = state.inputTokens;
  state.sessionId = sessionId;
  state.inputTokens = usage.inputTokens || state.inputTokens || null;
  state.totalTokens = usage.totalTokens || state.totalTokens || null;
  state.contextWindow = usage.contextWindow || state.contextWindow || null;
  state.lastTokenUsage = usage.lastTokenUsage;
  state.totalTokenUsage = usage.totalTokenUsage;
  state.updatedAt = timestamp;

  if (previousInputTokens && usage.inputTokens && previousInputTokens > 20000 && usage.inputTokens < previousInputTokens * 0.62) {
    state.autoCompactDetected = true;
    state.autoCompactLastAt = timestamp;
    state.autoCompactReason = '上下文用量回落';
  }
}

export async function readRolloutContextState(filePath, sessionId) {
  const state = { sessionId, runtime: null };
  if (!filePath) {
    return state;
  }

  let start = 0;
  try {
    const stats = await fs.stat(filePath);
    if (stats.size > ROLLOUT_CONTEXT_READ_BYTES) {
      start = stats.size - ROLLOUT_CONTEXT_READ_BYTES;
    }
  } catch {
    return state;
  }

  const stream = fsSync.createReadStream(filePath, { encoding: 'utf8', start });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        applyContextEntry(state, JSON.parse(line), sessionId);
      } catch {
        // Skip malformed or partial JSONL rows.
      }
    }
  } catch {
    return state;
  }
  return state;
}

export function paginateMessages(messages, { limit = 120, offset = null, latest = true } = {}) {
  const total = messages.length;
  const count = Number(limit) || 0;
  const hasOffset = offset !== null && offset !== undefined;
  const start = hasOffset
    ? Math.max(0, Number(offset) || 0)
    : latest && count
      ? Math.max(0, total - count)
      : 0;
  const end = count ? start + count : undefined;
  return {
    messages: messages.slice(start, end),
    total,
    offset: start,
    hasMore: end ? end < total : false,
    hasMoreBefore: start > 0
  };
}

function messageTimestampValue(message) {
  const value = Date.parse(message?.timestamp || '');
  return Number.isFinite(value) ? value : 0;
}

function sortMessagesByConversationOrder(messages) {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftTurnId = left.message?.turnId || '';
      const rightTurnId = right.message?.turnId || '';
      if (leftTurnId && leftTurnId === rightTurnId) {
        return left.index - right.index;
      }
      const timestampDelta = messageTimestampValue(left.message) - messageTimestampValue(right.message);
      return timestampDelta || left.index - right.index;
    })
    .map((item) => item.message);
}

export function isoFromEpochSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(seconds * 1000).toISOString();
}

const DEFAULT_DESKTOP_READ_TIMEOUT_MS = Math.max(
  0,
  Number(process.env.CODEXMOBILE_DESKTOP_READ_TIMEOUT_MS) || 400
);
const DEFAULT_CACHE_MAX_ENTRIES = Math.max(
  0,
  Number(process.env.CODEXMOBILE_MESSAGE_CACHE_MAX) || 64
);

function deletedIdsSignature(set) {
  if (!set || typeof set.size !== 'number' || set.size === 0) {
    return '0';
  }
  return `${set.size}:${[...set].sort().join(',')}`;
}

function makeMessageCacheKey(sessionId, filePath, mtimeMs, deletedSig, options) {
  return [
    sessionId,
    filePath,
    mtimeMs,
    options.limit ?? 120,
    options.offset == null ? 'null' : options.offset,
    options.latest ? 1 : 0,
    options.includeActivity ? 1 : 0,
    deletedSig
  ].join('|');
}

export function createSessionMessageReader({
  readDeletedMessageIds = defaultReadDeletedMessageIds,
  readDesktopThread = defaultReadDesktopThread,
  messagesFromDesktopThread = defaultMessagesFromDesktopThread,
  readRawSessionActivities = defaultReadRawSessionActivities,
  readDesktopCollabActivities = defaultReadDesktopCollabActivities,
  removeFallbackActivitiesCoveredByRaw = defaultRemoveFallbackActivitiesCoveredByRaw,
  upsertDesktopActivity = defaultUpsertDesktopActivity,
  sortDesktopActivitySteps = defaultSortDesktopActivitySteps,
  filterDeletedMessages = defaultFilterDeletedMessages,
  readRolloutContextState: readRolloutContextStateImpl = readRolloutContextState,
  resolveSessionThread = async () => null,
  getConfigContext = () => ({}),
  desktopReadTimeoutMs = DEFAULT_DESKTOP_READ_TIMEOUT_MS,
  cacheMaxEntries = DEFAULT_CACHE_MAX_ENTRIES,
  statFile = (filePath) => fs.stat(filePath)
} = {}) {
  // LRU cache (Map preserves insertion order; re-insert on access).
  // Only rollout-file-sourced results are cached — desktop IPC results
  // never enter the cache, since the live desktop thread has no version
  // marker we can key on.
  const cache = new Map();

  function lruGet(key) {
    if (!cache.has(key)) return undefined;
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  function lruSet(key, value) {
    if (cacheMaxEntries <= 0) return;
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > cacheMaxEntries) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  function invalidateSessionMessages(sessionId) {
    if (!sessionId) return;
    const prefix = `${sessionId}|`;
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
  }

  async function readDesktopThreadWithTimeout(sessionId) {
    if (!Number.isFinite(desktopReadTimeoutMs) || desktopReadTimeoutMs <= 0) {
      return readDesktopThread(sessionId, { includeTurns: true });
    }
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('desktop thread read timed out');
        err.code = 'CODEXMOBILE_DESKTOP_BRIDGE_UNAVAILABLE';
        reject(err);
      }, desktopReadTimeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    try {
      return await Promise.race([
        readDesktopThread(sessionId, { includeTurns: true }),
        timeoutPromise
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function readThread(sessionId) {
    // Rollout file first. It carries the same conversation the desktop would
    // serialise back to us, and reading it costs one file read instead of a
    // fresh `codex app-server` spawn (~1.3s on Windows — it always lost the
    // desktop-read race anyway, so the spawn was pure waste).
    const session = await resolveSessionThread(sessionId);
    const filePath = session?.filePath || session?.path || '';
    const rolloutThread = filePath
      ? await readRolloutThreadFromFile(filePath, sessionId).catch(() => null)
      : null;
    if (rolloutThread && desktopThreadHasMessages(rolloutThread)) {
      return { thread: rolloutThread, source: 'rollout' };
    }

    // No rollout content yet (fresh thread, file not flushed, mobile-only
    // session): ask the desktop.
    try {
      const response = await readDesktopThreadWithTimeout(sessionId);
      if (response?.thread) {
        return { thread: response.thread, source: 'desktop' };
      }
    } catch (error) {
      if (!canFallbackToRollout(error)) {
        throw error;
      }
    }

    if (rolloutThread) {
      return { thread: rolloutThread, source: 'rollout' };
    }
    const error = new Error('Desktop thread not found');
    error.statusCode = 404;
    throw error;
  }

  async function readSessionMessages(sessionId, options = {}) {
    const { limit = 120, offset = null, latest = true, includeActivity = false } = options;
    const normalized = { limit, offset, latest, includeActivity };
    const deletedIds = await readDeletedMessageIds(sessionId);
    const deletedSig = deletedIdsSignature(deletedIds);

    // Cache probe: only attempt when we can resolve a stable rollout
    // file path + mtime. Any failure here just skips the cache.
    let cacheKey = null;
    if (cacheMaxEntries > 0) {
      try {
        const session = await resolveSessionThread(sessionId);
        const filePath = session?.filePath || session?.path || '';
        if (filePath) {
          const stat = await statFile(filePath).catch(() => null);
          if (stat && Number.isFinite(stat.mtimeMs)) {
            cacheKey = makeMessageCacheKey(sessionId, filePath, stat.mtimeMs, deletedSig, normalized);
            const hit = lruGet(cacheKey);
            if (hit) return hit;
          }
        }
      } catch {
        // Swallow — fall through to normal read.
      }
    }

    const { thread, source } = await readThread(sessionId);
    const messages = Array.isArray(thread.messages)
      ? thread.messages.map((message) => ({ ...message }))
      : messagesFromDesktopThread(thread, { includeActivity });

    if (includeActivity) {
      // A rollout-sourced thread already carries its command steps and turn
      // narration from the single parse above — re-reading the same file for
      // them is the expensive part of opening a big session.
      if (source !== 'rollout') {
        const rawActivities = await readRawSessionActivities(thread.path, thread.turns || []);
        removeFallbackActivitiesCoveredByRaw(messages, rawActivities);
        for (const item of rawActivities) {
          upsertDesktopActivity(messages, item.turnId, item.activity, item.segmentIndex);
        }
        const collabActivities = await readDesktopCollabActivities(thread.path);
        for (const item of collabActivities) {
          upsertDesktopActivity(messages, item.turnId, item.activity, item.segmentIndex);
        }
      }
      for (const item of Array.isArray(thread.activities) ? thread.activities : []) {
        upsertDesktopActivity(messages, item.turnId, item.activity, item.segmentIndex);
      }
      sortDesktopActivitySteps(messages);
    }

    const orderedMessages = sortMessagesByConversationOrder(messages);
    const contextState = await readRolloutContextStateImpl(thread.path, sessionId);
    const result = {
      ...paginateMessages(filterDeletedMessages(orderedMessages, deletedIds), { limit, offset, latest }),
      context: publicContextState(contextState, getConfigContext() || {})
    };

    if (cacheKey && source === 'rollout') {
      lruSet(cacheKey, result);
    }
    return result;
  }

  return { readSessionMessages, invalidateSessionMessages };
}
