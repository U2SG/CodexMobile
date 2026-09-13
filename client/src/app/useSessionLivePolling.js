import { useEffect, useRef } from 'react';

import { apiFetch } from '../api.js';
import { messageStreamSignature } from '../chat/activity-model.js';
import {
  mergeLiveSelectedThreadMessages,
  shouldPollSelectedSessionMessages
} from '../session-live-refresh.js';
import { isDraftSession, sessionMessagesPath } from './session-utils.js';

export function useSessionLivePolling({
  authenticated,
  selectedSession,
  selectedSessionRef,
  running = false,
  desktopBridge = null,
  setMessages
}) {
  const pollingRef = useRef(false);

  useEffect(() => {
    if (!authenticated || !selectedSession?.id || isDraftSession(selectedSession)) {
      return undefined;
    }

    const sessionId = selectedSession.id;
    let stopped = false;

    async function pollSelectedSession() {
      if (stopped || pollingRef.current) {
        return;
      }
      const hasExternalThreadRefresh = Boolean(
        desktopBridge?.openThreadIds?.includes?.(sessionId)
      );
      if (!shouldPollSelectedSessionMessages({
        hasSelectedRunning: running,
        desktopBridge,
        hasExternalThreadRefresh
      })) {
        return;
      }

      pollingRef.current = true;
      try {
        const data = await apiFetch(sessionMessagesPath(sessionId));
        if (stopped || selectedSessionRef.current?.id !== sessionId || !Array.isArray(data.messages)) {
          return;
        }
        setMessages((current) => {
          if (messageStreamSignature(current) === messageStreamSignature(data.messages)) {
            return current;
          }
          return mergeLiveSelectedThreadMessages(current, data.messages);
        });
      } catch {
        // Keep the currently rendered conversation if a transient poll fails.
      } finally {
        pollingRef.current = false;
      }
    }

    const intervalMs = running ? 900 : 2500;
    const timer = window.setInterval(pollSelectedSession, intervalMs);
    pollSelectedSession();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [
    authenticated,
    selectedSession?.id,
    running,
    desktopBridge,
    selectedSessionRef,
    setMessages
  ]);
}
