// useAppEventStream — owns the live channel (/api/events, Server-Sent Events)
// and dispatches every inbound payload type to the right App-level setter.
// Transport, cursor and reconnect rules live in event-stream.js; this hook
// only maps payloads to state. Frames replayed after a reconnect go through
// the same handlers as live ones, so they must stay idempotent (they upsert).

import { useEffect } from 'react';

import { apiFetch, getToken, notifyAuthLost } from '../api.js';
import { sameUserMessageContent } from '../chat/message-identity.js';
import { createAssistantStreamBuffer } from '../chat/assistant-stream-buffer.js';
import { finishClientTurnLatency, markClientTurnLatency } from '../turn-latency.js';
import { createEventStream } from './event-stream.js';
import { isDraftSession, sessionMessagesPath } from './session-utils.js';

export function useAppEventStream({
  authenticated,
  defaultStatus,
  selectedProjectRef,
  selectedSessionRef,
  sessionsByProjectRef,
  setConnectionState,
  setStatus,
  setSelectedSession,
  setSessionsByProject,
  setMessages,
  setProjects,
  setPinFolders,
  setPinnedSessions,
  setDesktopBridge,
  syncActiveRunsFromStatus,
  markRun,
  clearRun,
  markTurnCompleted,
  scheduleTurnRefresh,
  payloadMatchesCurrentConversation,
  upsertSessionInProject,
  upsertStatusMessage,
  upsertActivityMessage,
  upsertAssistantMessage,
  briefActivityLabel,
  pushApprovalRequest,
  dropApprovalRequest,
  onQueueUpdated
}) {
  useEffect(() => {
    if (!authenticated || !getToken()) {
      setConnectionState('disconnected');
      return undefined;
    }

    let stopped = false;
    const streamBuffer = createAssistantStreamBuffer();

    function applyAssistantUpdate(payload) {
      if (!payloadMatchesCurrentConversation(payload)) {
        return;
      }
      if (payload.phase === 'commentary') {
        setMessages((current) =>
          upsertStatusMessage(current, {
            ...payload,
            kind: payload.kind || 'agent_message',
            label: briefActivityLabel(payload.content),
            status: payload.status || 'running'
          })
        );
        return;
      }
      setMessages((current) => upsertAssistantMessage(current, payload));
    }

    // The log no longer covers our cursor (server restarted, or we were away
    // long enough for the buffer to roll over): whatever happened meanwhile
    // is only in server state. Replace, don't merge — merging a stale page
    // into a live stream is what rolled back streaming replies before.
    function resyncAfterGap() {
      apiFetch('/api/projects')
        .then((data) => {
          if (!stopped && Array.isArray(data?.projects)) setProjects(data.projects);
        })
        .catch(() => null);
      const project = selectedProjectRef.current;
      if (project?.id) {
        apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`)
          .then((data) => {
            if (!stopped) setSessionsByProject((current) => ({ ...current, [project.id]: data.sessions || [] }));
          })
          .catch(() => null);
      }
      const session = selectedSessionRef.current;
      if (session?.id && !isDraftSession(session)) {
        apiFetch(sessionMessagesPath(session.id))
          .then((data) => {
            if (!stopped && selectedSessionRef.current?.id === session.id && Array.isArray(data?.messages)) {
              setMessages(data.messages);
            }
          })
          .catch(() => null);
      }
    }

    function handlePayload(payload) {
      if (payload.turnId) {
        markClientTurnLatency(payload.turnId, 'firstWsEvent');
      }
      if (payload.type === 'heartbeat') {
        if (payload.buildId) {
          // Merge only — a rebuilt client/dist flips status.buildId, which
          // App.jsx compares against its own bundle hash to show the
          // update banner without waiting for a reconnect.
          setStatus((current) =>
            current?.buildId === payload.buildId ? current : { ...(current || defaultStatus), buildId: payload.buildId }
          );
        }
        return;
      }
      if (payload.type === 'connected') {
        setStatus(payload.status || defaultStatus);
        setConnectionState(payload.status?.connected ? 'connected' : 'disconnected');
        syncActiveRunsFromStatus(payload.status || defaultStatus);
        return;
      }
      if (payload.type === 'chat-started') {
        // Only the run registry cares about this frame now. Auto-selecting
        // the frame's session when nothing was open yanked the user into
        // whatever background turn happened to start (another device's, a
        // queued job's) — the classic "someone else's chat appeared".
        markRun(payload);
        return;
      }
      if (payload.type === 'thread-started' && payload.sessionId) {
        const projectId = payload.projectId || selectedProjectRef.current?.id || selectedSessionRef.current?.projectId;
        const currentSession = selectedSessionRef.current;
        // The originating draft is keyed by previousSessionId — not necessarily
        // the currently-selected session. If the user clicked New Chat again
        // while this turn was still thinking, selectedSession now points at
        // the second draft ("新对话"), and inheriting its title would tag the
        // newly-promoted real session as "新对话" too — producing two
        // identical "新对话" rows side-by-side. Look the original draft up
        // in the per-project list by previousSessionId so the title and any
        // turn-time metadata land on the right row regardless of selection.
        const projectSessions = projectId ? sessionsByProjectRef.current?.[projectId] || [] : [];
        const originatingDraft = payload.previousSessionId
          ? projectSessions.find((session) => session.id === payload.previousSessionId)
          : null;
        const seed = originatingDraft
          || (currentSession?.id === payload.previousSessionId ? currentSession : null)
          || currentSession
          || {};
        const nextSession = {
          ...seed,
          id: payload.sessionId,
          projectId,
          title: seed.title || '新对话',
          updatedAt: new Date().toISOString(),
          draft: false
        };
        markRun(payload);
        setSelectedSession((current) => {
          if (!current) {
            // Browsing the session list while a thread promotes elsewhere —
            // update the list row below, but don't yank the user into it.
            return current;
          }
          const shouldReplace =
            current.id === payload.previousSessionId ||
            current.id === payload.sessionId ||
            current.turnId === payload.turnId;
          return shouldReplace ? { ...current, ...nextSession } : current;
        });
        setSessionsByProject((current) =>
          upsertSessionInProject(current, projectId, nextSession, payload.previousSessionId)
        );
        setMessages((current) =>
          current.map((message) =>
            message.turnId === payload.turnId || message.sessionId === payload.previousSessionId
              ? { ...message, sessionId: payload.sessionId }
              : message
          )
        );
        return;
      }
      if (payload.type === 'approval-request' && payload.requestId) {
        // Approvals are global process state, not chat-message stream data.
        // A mobile PWA may be looking at a different session, or reconnect
        // after the original broadcast; still surface the prompt so the
        // waiting turn can resume.
        pushApprovalRequest?.(payload);
        return;
      }
      if (payload.type === 'message-deleted') {
        if (payloadMatchesCurrentConversation(payload)) {
          setMessages((current) => current.filter((message) => String(message.id) !== String(payload.messageId)));
        }
        return;
      }
      if (payload.type === 'user-message') {
        if (!payloadMatchesCurrentConversation(payload)) {
          return;
        }
        setMessages((current) => {
          // Use sameUserMessageContent (not ===) so an optimistic message that
          // included a markdown image preview matches the server's plain-text
          // sync, dropping the dup. Pure-text messages still compare exactly.
          const alreadyShown = current.some(
            (message) => message.role === 'user' && sameUserMessageContent(message.content, payload.message.content)
          );
          if (alreadyShown) {
            return current;
          }
          return [...current, payload.message];
        });
        return;
      }
      if (payload.type === 'assistant-update') {
        if (!payload.content?.trim()) {
          return;
        }
        markClientTurnLatency(payload.turnId, 'firstAssistantFrame');
        markRun(payload);
        streamBuffer.schedule(payload, applyAssistantUpdate);
        return;
      }
      if (payload.type === 'status-update') {
        if (payload.status === 'running' || payload.status === 'queued') {
          markRun(payload);
        }
        if (!payloadMatchesCurrentConversation(payload)) {
          return;
        }
        if (payload.kind === 'turn' && payload.status === 'completed') {
          markTurnCompleted(payload);
          return;
        }
        setMessages((current) => upsertStatusMessage(current, payload));
        return;
      }
      if (payload.type === 'activity-update') {
        if (payload.status === 'running' || payload.status === 'queued') {
          markRun(payload);
        }
        if (!payloadMatchesCurrentConversation(payload)) {
          return;
        }
        setMessages((current) => upsertActivityMessage(current, payload));
        return;
      }
      if (payload.type === 'chat-complete' || payload.type === 'chat-error' || payload.type === 'chat-aborted') {
        finishClientTurnLatency(
          payload.turnId,
          payload.type === 'chat-complete' ? 'completed' : payload.type === 'chat-aborted' ? 'aborted' : 'failed'
        );
        // Drop any unanswered approvals for this turn — the server already
        // moved on, so the prompt is stale.
        dropApprovalRequest?.({ turnId: payload.turnId });
        streamBuffer.flushAll();
        if (!payloadMatchesCurrentConversation(payload)) {
          clearRun(payload);
          return;
        }
        if (payload.type === 'chat-complete') {
          markTurnCompleted(payload);
          scheduleTurnRefresh(payload);
          return;
        }
        clearRun(payload);
        if (payload.type === 'chat-error' && payload.error) {
          setMessages((current) =>
            upsertStatusMessage(current, {
              ...payload,
              status: 'failed',
              label: '任务失败',
              detail: payload.error
            })
          );
        } else if (payload.type === 'chat-aborted') {
          setMessages((current) =>
            upsertStatusMessage(current, {
              ...payload,
              status: 'completed',
              label: '已中止'
            })
          );
        }
        return;
      }
      if (payload.type === 'queue-updated') {
        // Server-driven invalidation: the queue mutated outside of this
        // tab's send/remove/restore round trips (e.g. a queued draft was
        // shifted out and started running, or another tab queued one).
        // Refresh only when the current selection actually matches the
        // event's session so other-tab traffic doesn't churn an unrelated
        // composer.
        const current = selectedSessionRef.current;
        if (!current || !onQueueUpdated) {
          return;
        }
        const matches =
          (payload.sessionId && current.id === payload.sessionId) ||
          (payload.draftSessionId && current.id === payload.draftSessionId);
        if (matches) {
          onQueueUpdated(current);
        }
        return;
      }
      if (payload.type === 'desktop-threads' && Array.isArray(payload.openThreadIds)) {
        setDesktopBridge((current) => ({ ...(current || {}), openThreadIds: payload.openThreadIds }));
        return;
      }
      if (payload.type === 'desktop-bridge-changed' && payload.status) {
        // Server pushes this when bridgeStatusCache detects a connected/
        // reason/mode flip — usually triggered by thread tracker (re)connect
        // events. Replace local state so PWAs don't have to wait for the
        // 30s useDesktopBridge poll to see desktop restart effects.
        setDesktopBridge(payload.status);
        return;
      }
      if (payload.type === 'compact-complete') {
        const current = selectedSessionRef.current;
        if (current && current.id === payload.sessionId && payload.summaryUuid) {
          apiFetch(sessionMessagesPath(payload.sessionId))
            .then((data) => {
              // Re-check after the fetch — the user may have switched sessions while
              // we were loading, in which case dropping these messages into the new
              // chat would replace it with the wrong session's contents.
              if (data.messages?.length && selectedSessionRef.current?.id === payload.sessionId) {
                setMessages(data.messages);
              }
            })
            .catch(() => null);
        }
        return;
      }
      if (payload.type === 'sync-complete' && payload.projects) {
        setProjects(payload.projects);
        if (Array.isArray(payload.pinFolders)) {
          setPinFolders(payload.pinFolders);
        } else {
          apiFetch('/api/pin-folders').then((data) => {
            if (Array.isArray(data?.folders)) setPinFolders(data.folders);
          }).catch(() => null);
        }
        apiFetch('/api/pinned-sessions').then((data) => {
          if (Array.isArray(data?.sessions)) setPinnedSessions(data.sessions);
          if (Array.isArray(data?.folders)) setPinFolders(data.folders);
        }).catch(() => null);
        // Clear any empty session lists cached before the sync completed so
        // that re-expanding those projects triggers a fresh load.
        setSessionsByProject((current) => {
          const next = { ...current };
          for (const [projectId, sessions] of Object.entries(next)) {
            if (!sessions?.length) {
              delete next[projectId];
            }
          }
          return next;
        });
        const project = selectedProjectRef.current;
        if (project?.id) {
          apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`)
            .then((data) => {
              setSessionsByProject((current) => ({ ...current, [project.id]: data.sessions || [] }));
            })
            .catch(() => null);
        }
      }
    }

    const stream = createEventStream({
      getToken,
      onPayload: handlePayload,
      onResume: (status) => {
        if (status === 'gap') resyncAfterGap();
      },
      onStateChange: (state) => {
        // 'connected' is reported by the hello 'connected' frame, which also
        // carries the server status; only surface the in-between states here.
        if (state !== 'connected') setConnectionState(state);
      },
      onAuthRejected: (token) => notifyAuthLost(token)
    });
    stream.start();

    const handleForeground = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        stream.onForeground();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleForeground);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleForeground);
      // bfcache restores fire pageshow, not visibilitychange.
      window.addEventListener('pageshow', handleForeground);
    }

    return () => {
      stopped = true;
      stream.stop();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleForeground);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleForeground);
        window.removeEventListener('pageshow', handleForeground);
      }
      streamBuffer.flushAll();
      setConnectionState('disconnected');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated]);
}
