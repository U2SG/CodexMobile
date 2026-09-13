// HTTP surface for the file ↔ session index built in file-session-index.js.
// Resolves a project-relative `path` query parameter against the project's
// cwd into an absolute path before consulting the index. Returns at most
// `limit` recent sessions (default 5).

import path from 'node:path';
import { sendJson } from './http-utils.js';

export function createFileSessionRoutes({ fileSessionIndex, getProject } = {}) {
  if (!fileSessionIndex) throw new Error('createFileSessionRoutes: fileSessionIndex is required');
  if (typeof getProject !== 'function') throw new Error('createFileSessionRoutes: getProject is required');

  return async function handle(req, res, ctx) {
    const { method, pathname, parts, url } = ctx;

    // GET /api/files/sessions?projectId=&path=&limit= — forward direction
    // (which sessions edited this file?). See file-session-index.js for
    // signal scope.
    if (method === 'GET' && pathname === '/api/files/sessions') {
      const projectId = url.searchParams.get('projectId');
      const relPath = url.searchParams.get('path');
      if (!projectId) {
        sendJson(res, 400, { error: 'projectId is required' });
        return true;
      }
      if (!relPath || typeof relPath !== 'string') {
        sendJson(res, 400, { error: 'path is required' });
        return true;
      }
      const project = getProject(projectId);
      if (!project) {
        sendJson(res, 404, { error: 'Project not found' });
        return true;
      }
      if (!project.path) {
        sendJson(res, 400, { error: 'Project has no path' });
        return true;
      }

      const limitRaw = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(20, Math.floor(limitRaw)) : 5;

      // Resolve under the project's path. path.resolve handles both
      // POSIX-style ("src/foo.js") and absolute callers cleanly — if
      // `relPath` is absolute, it overrides the base.
      const absPath = path.resolve(project.path, relPath);
      try {
        const sessions = await fileSessionIndex.getSessionsForFile(absPath, { limit });
        sendJson(res, 200, { absPath, sessions });
      } catch (error) {
        sendJson(res, error.statusCode || 500, { error: error.message || 'file-session lookup failed' });
      }
      return true;
    }

    // GET /api/sessions/:id/files?limit= — reverse direction (which files
    // did this session edit?). No projectId needed: sessions identify
    // themselves and the index already records their cwd.
    if (
      method === 'GET' &&
      parts.length === 4 &&
      parts[0] === 'api' &&
      parts[1] === 'sessions' &&
      parts[3] === 'files'
    ) {
      const sessionId = parts[2];
      if (!sessionId) {
        sendJson(res, 400, { error: 'sessionId is required' });
        return true;
      }
      const limitRaw = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 200;
      try {
        const result = await fileSessionIndex.getFilesForSession(sessionId, { limit });
        sendJson(res, 200, { sessionId, cwd: result.cwd, files: result.files });
      } catch (error) {
        sendJson(res, error.statusCode || 500, { error: error.message || 'session-files lookup failed' });
      }
      return true;
    }

    return false;
  };
}
