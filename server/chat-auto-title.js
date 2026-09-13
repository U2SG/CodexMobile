export function createChatAutoNamer({
  getTurn,
  refreshCodexCache,
  getSession,
  maybeAutoNameSession,
  renameSession,
  broadcast,
  logger = console
} = {}) {
  // Sessions with an LLM rename currently in flight. Desktop IPC mode schedules
  // an auto-name on every turn completion; without this guard a fast follow-up
  // turn would launch a second LLM call before the first one wrote
  // titleLocked, and the two would race — title would flip between two
  // generated summaries as each finished. Keyed by sessionId, cleared in
  // finally so a failed call doesn't permanently block future renames.
  const inFlight = new Set();

  async function autoNameCompletedSession({ sessionId, turnId, userMessage } = {}) {
    if (!sessionId || !turnId) return;
    const turn = getTurn?.(turnId) || {};
    const assistantMessage = turn.assistantPreview || '';
    if (!String(userMessage || assistantMessage || '').trim()) return;

    if (inFlight.has(sessionId)) return;

    await refreshCodexCache();
    const session = getSession(sessionId);
    if (!session || session.titleLocked) return;

    inFlight.add(sessionId);
    try {
      const renamed = await maybeAutoNameSession({
        session,
        userMessage,
        assistantMessage,
        renameSessionImpl: renameSession
      });
      if (renamed) {
        const snapshot = await refreshCodexCache();
        broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
      }
    } finally {
      inFlight.delete(sessionId);
    }
  }

  function scheduleAutoNameCompletedSession(payload) {
    autoNameCompletedSession(payload).catch((error) => {
      logger?.warn?.('[title] auto naming failed:', error.message);
    });
  }

  return { autoNameCompletedSession, scheduleAutoNameCompletedSession };
}
