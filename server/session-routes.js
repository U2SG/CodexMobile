import { readBody, sendJson } from './http-utils.js';

export function createSessionRoutes({
  listProjectSessions,
  getProject,
  getSession,
  renameSession,
  deleteSession,
  hideSessionMessage,
  readSessionMessages,
  sessionHasActiveWork = () => false,
  onMutation = async () => {},
  onMessageDeleted = async () => {},
  // Optional per-session predicate. When provided, sessions returning false
  // are dropped from GET /api/projects/:id/sessions. Used to keep Claude Code
  // sessions out of the Codex server's listing (and vice versa) since both
  // services scan the same on-disk session caches.
  filterSession = null
}) {
  const required = { listProjectSessions, getProject, getSession, renameSession, deleteSession, hideSessionMessage, readSessionMessages };
  for (const [name, value] of Object.entries(required)) {
    if (typeof value !== 'function') {
      throw new Error(`createSessionRoutes: ${name} is required`);
    }
  }
  const applyFilter = typeof filterSession === 'function'
    ? (sessions) => sessions.filter((s) => filterSession(s))
    : (sessions) => sessions;

  return async function handle(req, res, ctx) {
    const { method, parts, url } = ctx;

    // GET /api/projects/:id/sessions
    if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sessions') {
      const projectId = decodeURIComponent(parts[2]);
      sendJson(res, 200, { sessions: applyFilter(listProjectSessions(projectId)) });
      return true;
    }

    // PATCH/DELETE /api/projects/:id/sessions/:sid
    if (parts.length === 5 && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sessions') {
      const projectId = decodeURIComponent(parts[2]);
      const sessionId = decodeURIComponent(parts[4]);
      const project = getProject(projectId);
      if (!project) {
        sendJson(res, 404, { error: 'Project not found' });
        return true;
      }
      const session = getSession(sessionId);
      if (!session || session.projectId !== project.id) {
        sendJson(res, 404, { error: 'Session not found' });
        return true;
      }

      if (method === 'PATCH') {
        const body = await readBody(req);
        const title = String(body.title || '').trim().slice(0, 52);
        if (!title) {
          sendJson(res, 400, { error: 'Title is required' });
          return true;
        }
        try {
          const renamed = await renameSession(session.id, project.id, title);
          await onMutation({ type: 'session-renamed', sessionId, projectId });
          sendJson(res, 200, { success: true, session: renamed });
        } catch (error) {
          console.warn(`[sessions] rename failed session=${sessionId} project=${projectId}: ${error.message}`);
          sendJson(res, error.statusCode || 500, { error: error.message || 'Failed to rename session' });
        }
        return true;
      }

      if (method === 'DELETE') {
        if (sessionHasActiveWork(sessionId)) {
          sendJson(res, 409, { error: 'Session is running' });
          return true;
        }
        try {
          const deleted = await deleteSession(sessionId, project.id);
          await onMutation({ type: 'session-deleted', sessionId, projectId });
          sendJson(res, 200, { success: true, ...deleted });
        } catch (error) {
          const statusCode = error.statusCode || 500;
          console.warn(`[sessions] delete failed session=${sessionId} project=${projectId}: ${error.message}`);
          sendJson(res, statusCode, { error: statusCode === 409 ? error.message : 'Failed to delete session' });
        }
        return true;
      }
      return false;
    }

    // DELETE /api/sessions/:id/messages/:mid
    if (method === 'DELETE' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'messages') {
      const sessionId = decodeURIComponent(parts[2]);
      const messageId = decodeURIComponent(parts[4]);
      try {
        const deleted = await hideSessionMessage(sessionId, messageId);
        await onMessageDeleted(deleted);
        sendJson(res, 200, { success: true, ...deleted });
      } catch (error) {
        const statusCode = error.statusCode || 500;
        console.warn(`[sessions] message delete failed session=${sessionId} message=${messageId}: ${error.message}`);
        sendJson(res, statusCode, { error: statusCode === 400 ? error.message : 'Failed to delete message' });
      }
      return true;
    }

    // GET /api/sessions/:id/messages
    if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'messages') {
      const sessionId = decodeURIComponent(parts[2]);
      const limitParam = url.searchParams.get('limit');
      const offsetParam = url.searchParams.get('offset');
      const result = await readSessionMessages(sessionId, {
        limit: limitParam ? Number(limitParam) : 120,
        offset: offsetParam !== null ? Number(offsetParam) : null,
        latest: offsetParam === null || url.searchParams.get('latest') === '1',
        includeActivity: url.searchParams.get('includeActivity') === '1'
      });
      sendJson(res, 200, result);
      return true;
    }

    return false;
  };
}
