import { readBody, sendJson } from './http-utils.js';

export function createPinRoutes({ store, getSession, onMutation = async () => {} }) {
  if (!store) throw new Error('createPinRoutes: store is required');
  if (typeof getSession !== 'function') throw new Error('createPinRoutes: getSession is required');

  async function handleError(res, error, fallback) {
    const status = error.statusCode || 500;
    sendJson(res, status, { error: error.message || fallback });
  }

  return async function handle(req, res, ctx) {
    const { method, pathname, parts } = ctx;

    if (pathname === '/api/pin-folders') {
      if (method === 'GET') {
        const folders = await store.listPinFolders();
        sendJson(res, 200, { folders });
        return true;
      }
      if (method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const folder = await store.createPinFolder(body.name);
          await onMutation({ type: 'folder-created', folder });
          sendJson(res, 200, { success: true, folder });
        } catch (error) {
          await handleError(res, error, 'Failed to create folder');
        }
        return true;
      }
      return false;
    }

    if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'pin-folders') {
      const folderId = decodeURIComponent(parts[2]);
      if (method === 'PATCH') {
        try {
          const body = await readBody(req);
          const folder = await store.updatePinFolder(folderId, body);
          await onMutation({ type: 'folder-updated', folder });
          sendJson(res, 200, { success: true, folder });
        } catch (error) {
          await handleError(res, error, 'Failed to update folder');
        }
        return true;
      }
      if (method === 'DELETE') {
        try {
          const removed = await store.deletePinFolder(folderId);
          await onMutation({ type: 'folder-deleted', folderId });
          sendJson(res, 200, { success: true, removed });
        } catch (error) {
          await handleError(res, error, 'Failed to delete folder');
        }
        return true;
      }
      return false;
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'pin') {
      const sessionId = decodeURIComponent(parts[2]);
      if (method === 'DELETE') {
        try {
          const removed = await store.unpinSession(sessionId);
          await onMutation({ type: 'session-unpinned', sessionId });
          sendJson(res, 200, { success: true, removed });
        } catch (error) {
          await handleError(res, error, 'Failed to unpin session');
        }
        return true;
      }
      const session = getSession(sessionId);
      if (!session) {
        sendJson(res, 404, { error: 'Session not found' });
        return true;
      }
      if (method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const entry = await store.pinSession({
            sessionId,
            projectPath: session.cwd,
            folderId: body.folderId || null
          });
          await onMutation({ type: 'session-pinned', sessionId });
          sendJson(res, 200, { success: true, pin: entry });
        } catch (error) {
          await handleError(res, error, 'Failed to pin session');
        }
        return true;
      }
      if (method === 'PATCH') {
        try {
          const body = await readBody(req);
          const entry = await store.movePinnedToFolder(sessionId, body.folderId || null);
          await onMutation({ type: 'session-moved', sessionId });
          sendJson(res, 200, { success: true, pin: entry });
        } catch (error) {
          await handleError(res, error, 'Failed to move pinned session');
        }
        return true;
      }
      return false;
    }

    return false;
  };
}
