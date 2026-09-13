// useMessageActions — owns the two "what the user does to a conversation"
// handlers that used to live as inline blocks inside App.jsx.
// Pulled out as Batch G R14: pure refactor, same network call, same
// optimistic delete + restore-on-failure semantics, same window.confirm /
// window.alert surface.
//
// The optimistic-restore logic (re-insert the removed message at its
// original position if the DELETE call fails) is extracted as
// `restoreDeletedMessage` and tested in isolation.
//
// Inputs:
//   selectedProject            — current project (read for new-conversation seed)
//   projects                   — fallback project source when none is selected
//   selectedSessionRef         — ref read inside handleDeleteMessage to scope
//                                the restore to the still-visible session
//   messages                   — current message list (read for index-of)
//   setSelectedProject, setSelectedSession, setExpandedProjectIds,
//   setSessionsByProject, setMessages, setAttachments, setDrawerOpen
//                              — state mutators
//
// Returns:
//   { beginConversation, handleNewConversation, handleDeleteMessage }

import { apiFetch } from '../api.js';
import {
  createDraftSession,
  isDraftSession
} from './session-utils.js';

export function restoreDeletedMessage(current, { messageId, removedMessage, existingIndex }) {
  if (current.some((item) => String(item.id) === messageId)) {
    return current;
  }
  const next = [...current];
  const insertAt = existingIndex >= 0 ? Math.min(existingIndex, next.length) : next.length;
  next.splice(insertAt, 0, removedMessage);
  return next;
}

export function useMessageActions({
  selectedProject,
  projects,
  selectedSessionRef,
  messages,
  setSelectedProject,
  setSelectedSession,
  setExpandedProjectIds,
  setSessionsByProject,
  setMessages,
  setAttachments,
  setDrawerOpen
}) {
  // Create + select a fresh draft session in `project`. `workingDir` (a git
  // worktree path chosen from the picker) is stamped onto the draft so the
  // first turn runs there; omit it to run in the project root. Callers that
  // need the worktree picker should resolve the path first, then call this.
  function beginConversation(project, { workingDir = null, workingBranch = null } = {}) {
    if (!project) {
      return;
    }
    const draft = createDraftSession(project);
    if (workingDir) {
      draft.workingDir = workingDir;
      draft.workingBranch = workingBranch || null;
    }
    setSelectedProject(project);
    setSelectedSession(draft);
    setExpandedProjectIds((current) => ({ ...current, [project.id]: true }));
    setSessionsByProject((current) => {
      const existing = (current[project.id] || []).filter((item) => !isDraftSession(item));
      return { ...current, [project.id]: [draft, ...existing] };
    });
    setMessages([]);
    setAttachments([]);
    setDrawerOpen(false);
  }

  function handleNewConversation() {
    beginConversation(selectedProject || projects[0]);
  }

  async function handleDeleteMessage(message) {
    if (!message?.id) {
      return;
    }
    if (!window.confirm('删除这条消息？')) {
      return;
    }

    const messageId = String(message.id);
    const sessionId = selectedSessionRef.current?.id || message.sessionId || '';
    const existingIndex = messages.findIndex((item) => String(item.id) === messageId);
    const removedMessage = existingIndex >= 0 ? messages[existingIndex] : message;
    setMessages((current) => current.filter((item) => String(item.id) !== messageId));

    if (!sessionId || isDraftSession({ id: sessionId })) {
      return;
    }

    try {
      await apiFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
        { method: 'DELETE' }
      );
    } catch (error) {
      // Only restore the optimistically-removed message if the user is still
      // viewing the conversation it belonged to — otherwise it would appear
      // inside whatever session they navigated to during the failed DELETE.
      if (selectedSessionRef.current?.id === sessionId) {
        setMessages((current) =>
          restoreDeletedMessage(current, { messageId, removedMessage, existingIndex })
        );
      }
      window.alert(`删除失败：${error.message}`);
    }
  }

  return { beginConversation, handleNewConversation, handleDeleteMessage };
}
