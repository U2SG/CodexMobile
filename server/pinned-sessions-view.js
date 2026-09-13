// View-layer formatter for "list of pinned sessions" responses.
// Joins the pin snapshot to the session/project caches, filters by current
// agent, and sorts newest-pin-first. Pure data-shaping — no IO of its own
// beyond the injected pinStore.readPinSnapshot().
//
// Extracted from server/index.js (Batch H' wrap-up).

export function createPinnedSessionsView({
  pinStore,
  getCacheSnapshot,
  getSession,
  getProject,
  filterSession = () => true
}) {
  if (!pinStore) throw new Error('createPinnedSessionsView: pinStore is required');
  if (typeof getCacheSnapshot !== 'function') throw new Error('createPinnedSessionsView: getCacheSnapshot is required');
  if (typeof getSession !== 'function') throw new Error('createPinnedSessionsView: getSession is required');
  if (typeof getProject !== 'function') throw new Error('createPinnedSessionsView: getProject is required');

  return async function buildPinnedSessionsResponse() {
    const snapshot = await pinStore.readPinSnapshot();
    const folders = snapshot.folders || [];
    const cacheSnapshot = getCacheSnapshot();
    const projectsById = new Map((cacheSnapshot.projects || []).map((p) => [p.id, p]));

    const sessions = [];
    for (const [sessionId, entry] of snapshot.pinned.entries()) {
      const session = getSession(sessionId);
      const project = session?.projectId ? getProject(session.projectId) || projectsById.get(session.projectId) : null;
      const projectId = session?.projectId || null;
      const projectName = project?.name || null;
      const projectPath = project?.path || entry.projectPath || session?.cwd || null;

      if (!session) {
        // Pinned session may not be in current cache (e.g. archived / external) — still surface it.
        sessions.push({
          id: sessionId,
          title: '对话',
          summary: null,
          model: null,
          provider: null,
          source: null,
          updatedAt: null,
          projectId,
          projectName,
          projectPath,
          pinned: true,
          pinnedAt: entry.pinnedAt || null,
          folderId: entry.folderId || null
        });
        continue;
      }

      sessions.push({
        id: session.id,
        title: session.title || null,
        summary: session.summary || null,
        model: session.model || null,
        provider: session.provider || null,
        source: session.source || null,
        updatedAt: session.updatedAt || null,
        projectId,
        projectName,
        projectPath,
        pinned: true,
        pinnedAt: entry.pinnedAt || session.pinnedAt || null,
        folderId: entry.folderId || session.folderId || null
      });
    }

    sessions.sort((a, b) => {
      const ta = a.pinnedAt ? new Date(a.pinnedAt).getTime() : 0;
      const tb = b.pinnedAt ? new Date(b.pinnedAt).getTime() : 0;
      return tb - ta;
    });

    // Drop pins that belong to the other agent so the Claude server doesn't
    // surface Codex pins (and vice versa). Pins with unknown source/provider
    // are kept — see currentAgentMatchesSession.
    const filtered = sessions.filter((s) => filterSession(s));

    return { sessions: filtered, folders };
  };
}
