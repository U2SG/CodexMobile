// useTurnRuntime — owns the turn-tracking state machine that
// useAppWebSocket, useTurnSubmission, and the voice-dialog effects all
// share. Pure refactor (Stage 2 R7): the same state, the same refs, the
// same handler logic — extracted into one hook so callers don't need to
// know about runningByIdRef / activePollsRef / turnRefreshTimersRef
// individually.
//
// Manages:
//   * `runningById` state — keyed by turnId + sessionId, marks every
//     conversation that has work in flight. Read by the composer
//     (send-button mode), the activity overlays, and the voice dialog.
//   * `runningByIdRef` — mirror of the state so non-React reads inside
//     handlers see the latest value without a re-render.
//   * `lastLocalRunAtRef` — timestamp of the most recent markRun, used by
//     syncActiveRunsFromStatus to keep optimistic local runs alive for
//     ~15s after the server's activeRuns snapshot misses them (avoids a
//     flicker where the just-sent turn looks idle until the server
//     catches up).
//   * `activePollsRef` — Set of turnIds currently being polled by
//     pollTurnUntilComplete; prevents duplicate poll loops.
//   * `turnRefreshTimersRef` — Map of turnId → setTimeout handle for the
//     backoff retries in scheduleTurnRefresh; cleared on unmount.
//
// Returns:
//   runningById                      — state value (passed to composer / voice
//                                      effects / UI).
//   markRun(payload)                 — mark every key in the payload as running.
//   clearRun(payload)                — drop those keys.
//   payloadMatchesCurrentConversation(payload)
//                                    — true when payload's sessionId or
//                                      turnId matches the currently selected
//                                      session.
//   syncActiveRunsFromStatus(status) — reconcile local runs against the
//                                      server's activeRuns snapshot from
//                                      GET /api/status.
//   markTurnCompleted(payload, detail)
//                                    — collapse the in-progress placeholder
//                                      into a completed-or-running status
//                                      depending on whether the chat already
//                                      has an assistant message for the turn.
//   scheduleTurnRefresh(payload, attempt = 0)
//                                    — backoff retry that re-fetches a
//                                      session's messages until the assistant
//                                      reply shows up (or gives up after
//                                      ~90s).
//   pollTurnUntilComplete({turnId, optimisticSessionId, projectId, previousSessionId})
//                                    — long-poll /api/chat/turns/:id (1.4s
//                                      interval) until terminal status,
//                                      handling thread-id rewrites along
//                                      the way.

import { useEffect, useRef, useState } from 'react';

import { apiFetch } from '../api.js';
import {
  hasAssistantMessageForTurn,
  payloadRunKeys,
  removeActivityMessagesForTurn,
  upsertStatusMessage
} from '../chat/activity-model.js';
import { mergeLiveSelectedThreadMessages } from '../session-live-refresh.js';
import { sessionMessagesPath, upsertSessionInProject } from './session-utils.js';

// Visible == one whose `assistant` role message has non-empty trimmed
// text. Local helper for refreshMessagesForPayload + loadTurnMessages —
// avoids replacing the chat list with an empty assistant placeholder
// that the server just hasn't filled in yet.
function hasVisibleAssistantForTurn(messages, payload) {
  const hasExactTurnMatch = messages.some(
    (message) =>
      message.role === 'assistant' &&
      payload?.turnId &&
      message.turnId === payload.turnId &&
      typeof message.content === 'string' &&
      message.content.trim()
  );
  if (hasExactTurnMatch) {
    return true;
  }

  const latestUserIndex = messages.reduce(
    (latest, message, index) => (message.role === 'user' ? index : latest),
    -1
  );
  return messages.some(
    (message, index) =>
      message.role === 'assistant' &&
      index > latestUserIndex &&
      typeof message.content === 'string' &&
      message.content.trim()
  );
}

export function useTurnRuntime({
  selectedSessionRef,
  setMessages,
  setSelectedSession,
  setSessionsByProject
}) {
  const [runningById, setRunningById] = useState({});
  const runningByIdRef = useRef({});
  const lastLocalRunAtRef = useRef(0);
  const activePollsRef = useRef(new Set());
  const turnRefreshTimersRef = useRef(new Map());

  function markRun(payload) {
    const keys = payloadRunKeys(payload);
    if (!keys.length) {
      return;
    }
    lastLocalRunAtRef.current = Date.now();
    setRunningById((current) => {
      const next = { ...current };
      for (const key of keys) {
        next[key] = true;
      }
      runningByIdRef.current = next;
      return next;
    });
  }

  function clearRun(payload) {
    const keys = payloadRunKeys(payload);
    if (!keys.length) {
      return;
    }
    setRunningById((current) => {
      const next = { ...current };
      for (const key of keys) {
        delete next[key];
      }
      runningByIdRef.current = next;
      return next;
    });
  }

  function syncActiveRunsFromStatus(nextStatus) {
    const activeRuns = Array.isArray(nextStatus?.activeRuns) ? nextStatus.activeRuns : [];
    const shouldPreserveLocalRuns =
      activePollsRef.current.size > 0 ||
      turnRefreshTimersRef.current.size > 0 ||
      Date.now() - lastLocalRunAtRef.current < 15000;

    if (!activeRuns.length) {
      if (!shouldPreserveLocalRuns) {
        setRunningById(() => {
          const next = {};
          runningByIdRef.current = next;
          return next;
        });
      }
      setMessages((current) => {
        if (shouldPreserveLocalRuns) {
          return current;
        }
        return current.filter(
          (message) => !(message.role === 'activity' && (message.status === 'running' || message.status === 'queued'))
        );
      });
      return;
    }

    const nextRunning = {};
    for (const run of activeRuns) {
      for (const key of payloadRunKeys(run)) {
        nextRunning[key] = true;
      }
    }
    setRunningById((current) => {
      const next = shouldPreserveLocalRuns ? { ...current, ...nextRunning } : nextRunning;
      runningByIdRef.current = next;
      return next;
    });
  }

  function payloadMatchesCurrentConversation(payload) {
    const current = selectedSessionRef.current;
    if (!current) {
      // No conversation open — nothing on screen can legitimately receive
      // this frame. Returning true here used to paint any background turn
      // (another device, another session) into the next conversation view.
      return false;
    }
    const keys = payloadRunKeys(payload);
    return keys.includes(current.id) || keys.includes(current.turnId);
  }

  function clearTurnRefreshTimer(turnId) {
    if (!turnId) {
      return;
    }
    const timer = turnRefreshTimersRef.current.get(turnId);
    if (timer) {
      window.clearTimeout(timer);
      turnRefreshTimersRef.current.delete(turnId);
    }
  }

  async function refreshMessagesForPayload(payload) {
    if (!payload?.sessionId || !payloadMatchesCurrentConversation(payload)) {
      return false;
    }
    try {
      const data = await apiFetch(sessionMessagesPath(payload.sessionId));
      // Re-check after the fetch — the user may have switched sessions while
      // the request was in flight. Replacing messages now would clobber the
      // newly opened conversation with the old turn's history.
      if (!payloadMatchesCurrentConversation(payload)) {
        return false;
      }
      if (data.messages?.length && hasVisibleAssistantForTurn(data.messages, payload)) {
        setMessages((current) => mergeLiveSelectedThreadMessages(current, data.messages));
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  function finalizeTurnWithoutAssistant(payload) {
    if (!payload?.turnId) {
      return;
    }
    clearTurnRefreshTimer(payload.turnId);
    setMessages((current) =>
      upsertStatusMessage(current, {
        ...payload,
        status: 'completed',
        label: '任务已完成',
        detail: payload.error || payload.detail || ''
      })
    );
    clearRun(payload);
  }

  function markTurnCompleted(payload, detail = '结果同步中') {
    if (!payload?.turnId) {
      return;
    }
    // Skip if the current selection has moved on (e.g. user opened a new draft
    // while this turn was still completing in the background) — otherwise the
    // "正在思考中" placeholder leaks into the new session's empty chat.
    if (!payloadMatchesCurrentConversation(payload)) {
      return;
    }
    setMessages((current) => {
      if (hasAssistantMessageForTurn(current, payload)) {
        return removeActivityMessagesForTurn(current, payload);
      }
      return upsertStatusMessage(current, {
        ...payload,
        kind: 'turn',
        status: 'running',
        label: '正在思考中',
        detail
      });
    });
  }

  function scheduleTurnRefresh(payload, attempt = 0) {
    const turnId = payload?.turnId;
    if (!turnId || !payload?.sessionId || !payloadMatchesCurrentConversation(payload)) {
      return;
    }
    clearTurnRefreshTimer(turnId);
    const delays = [300, 800, 1500, 2500, 4000, 6500, 10000, 15000, 22000, 30000, 30000];
    const delay = delays[attempt];
    if (delay === undefined) {
      finalizeTurnWithoutAssistant(payload);
      return;
    }

    const timer = window.setTimeout(async () => {
      if (!payloadMatchesCurrentConversation(payload)) {
        return;
      }
      const loaded = await refreshMessagesForPayload(payload);
      if (loaded) {
        clearTurnRefreshTimer(turnId);
        clearRun(payload);
        return;
      }
      scheduleTurnRefresh(payload, attempt + 1);
    }, delay);
    turnRefreshTimersRef.current.set(turnId, timer);
  }

  function turnMatchesCurrentSelection(turnId, optimisticSessionId, realSessionId, previousSessionId) {
    const current = selectedSessionRef.current;
    if (!current) {
      return true;
    }
    return (
      current.id === optimisticSessionId ||
      current.id === realSessionId ||
      current.id === previousSessionId ||
      current.turnId === turnId
    );
  }

  function applyTurnSession(turn, optimisticSessionId, projectId, previousSessionId) {
    const sessionIdText = String(turn.sessionId || '');
    const realSessionId =
      sessionIdText && !sessionIdText.startsWith('draft-') && !sessionIdText.startsWith('codex-')
        ? sessionIdText
        : null;
    if (!realSessionId) {
      return null;
    }

    const currentSession = selectedSessionRef.current;
    const nextSession = {
      ...(currentSession || {}),
      id: realSessionId,
      projectId,
      title: currentSession?.title || '新对话',
      updatedAt: turn.completedAt || turn.updatedAt || new Date().toISOString(),
      draft: false
    };

    setSelectedSession((current) => {
      if (!current) {
        return nextSession;
      }
      if (!turnMatchesCurrentSelection(turn.turnId, optimisticSessionId, realSessionId, previousSessionId)) {
        return current;
      }
      return { ...current, ...nextSession };
    });
    setSessionsByProject((current) =>
      upsertSessionInProject(current, projectId, nextSession, previousSessionId || optimisticSessionId)
    );
    setMessages((current) =>
      current.map((message) =>
        message.turnId === turn.turnId || message.sessionId === optimisticSessionId || message.sessionId === previousSessionId
          ? { ...message, sessionId: realSessionId }
          : message
      )
    );
    return realSessionId;
  }

  async function loadTurnMessages(realSessionId, turnId, optimisticSessionId, previousSessionId) {
    if (!realSessionId) {
      return false;
    }
    const matchesSelection = () => {
      const current = selectedSessionRef.current;
      if (!current) return true;
      return (
        current.id === realSessionId ||
        current.id === optimisticSessionId ||
        current.id === previousSessionId ||
        current.turnId === turnId
      );
    };
    if (!matchesSelection()) {
      return false;
    }
    const data = await apiFetch(sessionMessagesPath(realSessionId));
    // Re-check after the fetch — user may have switched sessions while loading.
    if (!matchesSelection()) {
      return false;
    }
    if (data.messages?.length && hasVisibleAssistantForTurn(data.messages, { turnId })) {
      setMessages((current) => mergeLiveSelectedThreadMessages(current, data.messages));
      return true;
    }
    return false;
  }

  async function pollTurnUntilComplete({ turnId, optimisticSessionId, projectId, previousSessionId }) {
    if (!turnId || activePollsRef.current.has(turnId)) {
      return;
    }
    activePollsRef.current.add(turnId);
    const startedAt = Date.now();
    try {
      while (Date.now() - startedAt < 1800000) {
        await new Promise((resolve) => window.setTimeout(resolve, 1400));
        let turn = null;
        try {
          const result = await apiFetch(`/api/chat/turns/${encodeURIComponent(turnId)}`);
          turn = result.turn;
        } catch {
          continue;
        }
        if (!turn) {
          continue;
        }

        const realSessionId = applyTurnSession(turn, optimisticSessionId, projectId, previousSessionId);
        const terminalKey = { sessionId: realSessionId || optimisticSessionId, turnId, previousSessionId };
        if (turn.status === 'failed') {
          clearRun(terminalKey);
          // Only paint the failure into the chat if the user is still viewing
          // this conversation — otherwise the activity message bleeds into a
          // newly opened session.
          if (payloadMatchesCurrentConversation(terminalKey)) {
            setMessages((current) =>
              upsertStatusMessage(current, {
                sessionId: realSessionId || optimisticSessionId,
                turnId,
                kind: 'turn',
                status: 'failed',
                label: '任务失败',
                detail: turn.error || turn.detail || '任务失败'
              })
            );
          }
          break;
        }
        if (turn.status === 'aborted') {
          clearRun(terminalKey);
          if (payloadMatchesCurrentConversation(terminalKey)) {
            setMessages((current) =>
              upsertStatusMessage(current, {
                sessionId: realSessionId || optimisticSessionId,
                turnId,
                kind: 'turn',
                status: 'completed',
                label: '已中止'
              })
            );
          }
          break;
        }
        if (turn.status === 'completed') {
          const terminalPayload = {
            sessionId: realSessionId || optimisticSessionId,
            turnId,
            previousSessionId,
            detail: turn.detail || ''
          };
          markTurnCompleted(terminalPayload);
          const loaded = await loadTurnMessages(realSessionId, turnId, optimisticSessionId, previousSessionId);
          if (loaded) {
            clearRun(terminalPayload);
          } else {
            scheduleTurnRefresh({
              sessionId: realSessionId || optimisticSessionId,
              turnId,
              previousSessionId,
              hadAssistantText: turn.hadAssistantText || Boolean(turn.assistantPreview),
              usage: turn.usage || null
            });
          }
          break;
        }
      }
    } finally {
      activePollsRef.current.delete(turnId);
    }
  }

  // Cleanup outstanding backoff timers on unmount so a hot-reload or
  // navigation doesn't leak refresh attempts that race with the next mount.
  useEffect(
    () => () => {
      for (const timer of turnRefreshTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      turnRefreshTimersRef.current.clear();
    },
    []
  );

  return {
    runningById,
    markRun,
    clearRun,
    payloadMatchesCurrentConversation,
    syncActiveRunsFromStatus,
    markTurnCompleted,
    scheduleTurnRefresh,
    pollTurnUntilComplete
  };
}
