// useCompactAction — owns the /compact slash-command handler that used to
// live as an inline async block inside App.jsx.
// Pulled out as Batch G R16: pure refactor, same /api/chat/compact call,
// same optimistic activity message + session-context guard.
//
// The two presentation strings (success label varies on result.compacted,
// failure label classifies the error) are extracted as pure helpers so
// the regex and the boolean branch can be tested without rendering.
//
// Inputs:
//   selectedSessionRef   — ref read at every step to enforce the "still
//                          viewing the same session" guard
//   selectedProjectRef   — preferred project source; falls back to
//                          selectedProject if the ref is empty
//   selectedProject      — fallback project (passed flat because the ref
//                          may not be hydrated yet on first render)
//   setMessages          — message-list setter for the optimistic append +
//                          status updates
//
// Returns:
//   { handleCompact }

import { apiFetch } from '../api.js';
import { isDraftSession } from './session-utils.js';

const BUSY_ERROR_PATTERN = /running|busy|409/i;

// Pure helper: the failure label for the compact activity message. Returns
// the "task in progress" message when the server reports the session is
// still busy (running / busy / HTTP 409), otherwise the generic retry
// prompt.
export function compactErrorLabel(errorMessage) {
  return BUSY_ERROR_PATTERN.test(errorMessage)
    ? '任务进行中，请等待完成后再压缩'
    : '压缩失败，请重试';
}

// Pure helper: the success label. The server returns compacted=false when
// the session was too short to be worth compacting.
export function compactResultLabel(compacted) {
  return compacted === false ? '会话太短，无需压缩' : '会话已压缩';
}

export function useCompactAction({
  selectedSessionRef,
  selectedProjectRef,
  selectedProject,
  setMessages
}) {
  async function handleCompact() {
    const session = selectedSessionRef.current;
    const project = selectedProjectRef.current || selectedProject;
    if (!session || isDraftSession(session) || !project) {
      return;
    }
    const activityId = `compact-${Date.now()}`;
    setMessages((current) => [
      ...current,
      {
        id: activityId,
        role: 'activity',
        kind: 'turn',
        status: 'running',
        label: '正在压缩会话',
        sessionId: session.id,
        timestamp: new Date().toISOString()
      }
    ]);
    try {
      const result = await apiFetch('/api/chat/compact', {
        method: 'POST',
        body: { sessionId: session.id, projectId: project.id }
      });
      if (selectedSessionRef.current?.id !== session.id) {
        return;
      }
      setMessages((current) => current.map((message) =>
        message.id === activityId
          ? {
              ...message,
              status: 'completed',
              label: compactResultLabel(result.compacted),
              timestamp: new Date().toISOString()
            }
          : message
      ));
    } catch (error) {
      if (selectedSessionRef.current?.id !== session.id) {
        return;
      }
      setMessages((current) => current.map((message) =>
        message.id === activityId
          ? {
              ...message,
              status: 'failed',
              label: compactErrorLabel(error.message),
              detail: error.message,
              timestamp: new Date().toISOString()
            }
          : message
      ));
    }
  }

  return { handleCompact };
}
