// Top-level "meta" routes — server status, pairing handshake, sync trigger,
// project list, pinned-sessions snapshot. Split between pre-auth (status +
// pair) and post-auth (sync + projects + pinned-sessions) so the dispatcher
// can interleave the requireAuth gate.
//
// Extracted from server/index.js (Batch G R29). publicStatus and
// buildPinnedSessionsResponse remain in server/index.js (they aggregate
// state from many subsystems and pulling them in would balloon the factory
// args); the factory accepts them as opaque async functions.

import { readBody, sendJson } from './http-utils.js';
import { getClaudeSlashCommands } from './claude-slash-commands.js';
import { isClaudeMode } from './agent-mode.js';

export function createMetaRoutes({
  publicStatus,
  isAuthenticated,
  pairDevice,
  refreshCodexCache,
  broadcast,
  listProjects,
  getProject = () => null,
  hideProject = null,
  restoreProject = null,
  listArchivedProjects = null,
  listPinFolders,
  buildPinnedSessionsResponse,
  listAvailableSkills,
  listClaudeSlashCommands = getClaudeSlashCommands,
  remoteAddress
}) {
  if (typeof publicStatus !== 'function') throw new Error('createMetaRoutes: publicStatus is required');
  if (typeof isAuthenticated !== 'function') throw new Error('createMetaRoutes: isAuthenticated is required');
  if (typeof pairDevice !== 'function') throw new Error('createMetaRoutes: pairDevice is required');
  if (typeof refreshCodexCache !== 'function') throw new Error('createMetaRoutes: refreshCodexCache is required');
  if (typeof broadcast !== 'function') throw new Error('createMetaRoutes: broadcast is required');
  if (typeof listProjects !== 'function') throw new Error('createMetaRoutes: listProjects is required');
  if (typeof listPinFolders !== 'function') throw new Error('createMetaRoutes: listPinFolders is required');
  if (typeof buildPinnedSessionsResponse !== 'function') throw new Error('createMetaRoutes: buildPinnedSessionsResponse is required');
  if (typeof listAvailableSkills !== 'function') throw new Error('createMetaRoutes: listAvailableSkills is required');
  if (typeof remoteAddress !== 'function') throw new Error('createMetaRoutes: remoteAddress is required');

  async function preAuthHandle(req, res, ctx) {
    const { method, pathname } = ctx;

    if (method === 'GET' && pathname === '/api/status') {
      sendJson(res, 200, await publicStatus(await isAuthenticated(req)));
      return true;
    }

    if (method === 'POST' && pathname === '/api/pair') {
      const body = await readBody(req);
      const paired = await pairDevice({
        code: body.code,
        deviceName: body.deviceName,
        userAgent: req.headers['user-agent'],
        remoteAddress: remoteAddress(req)
      });
      if (!paired) {
        sendJson(res, 403, { error: 'Invalid pairing code' });
        return true;
      }
      sendJson(res, 200, paired);
      return true;
    }

    return false;
  }

  async function postAuthHandle(req, res, ctx) {
    const { method, pathname } = ctx;

    if (method === 'POST' && pathname === '/api/sync') {
      const snapshot = await refreshCodexCache();
      broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
      sendJson(res, 200, { success: true, ...snapshot });
      return true;
    }

    if (method === 'GET' && pathname === '/api/projects') {
      sendJson(res, 200, { projects: listProjects(), pinFolders: await listPinFolders() });
      return true;
    }

    if (method === 'GET' && pathname === '/api/projects/archived') {
      const archived = typeof listArchivedProjects === 'function' ? await listArchivedProjects() : [];
      sendJson(res, 200, { projects: archived });
      return true;
    }

    if (method === 'POST' && pathname === '/api/projects/archive') {
      if (typeof hideProject !== 'function') {
        sendJson(res, 404, { error: 'Project archive is not available' });
        return true;
      }
      const body = await readBody(req);
      const suppliedProject = body.project && typeof body.project === 'object' ? body.project : body;
      const projectId = String(suppliedProject?.id || '').trim();
      const project = getProject(projectId) || suppliedProject;
      if (!project?.id) {
        sendJson(res, 400, { error: 'Project id is required' });
        return true;
      }
      const archived = await hideProject(project);
      const snapshot = await refreshCodexCache();
      broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
      sendJson(res, 200, { success: true, ...archived, ...snapshot });
      return true;
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)(?:\/restore)?$/);
    if (projectMatch && (method === 'DELETE' || method === 'POST')) {
      const projectId = decodeURIComponent(projectMatch[1]);
      const isRestore = pathname.endsWith('/restore');
      if (method === 'POST' && !isRestore) {
        return false;
      }
      if (method === 'DELETE' && isRestore) {
        return false;
      }
      if (isRestore) {
        if (typeof restoreProject !== 'function') {
          sendJson(res, 404, { error: 'Project restore is not available' });
          return true;
        }
        const restored = await restoreProject(projectId);
        const snapshot = await refreshCodexCache();
        broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
        sendJson(res, 200, { success: true, ...restored, ...snapshot });
        return true;
      }

      const project = getProject(projectId);
      if (!project) {
        sendJson(res, 404, { error: 'Project not found' });
        return true;
      }
      if (typeof hideProject !== 'function') {
        sendJson(res, 404, { error: 'Project archive is not available' });
        return true;
      }
      const archived = await hideProject(project);
      const snapshot = await refreshCodexCache();
      broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
      sendJson(res, 200, { success: true, ...archived, ...snapshot });
      return true;
    }

    if (method === 'GET' && pathname === '/api/pinned-sessions') {
      sendJson(res, 200, await buildPinnedSessionsResponse());
      return true;
    }

    if (method === 'GET' && pathname === '/api/skills') {
      const skills = await listAvailableSkills();
      sendJson(res, 200, { skills });
      return true;
    }

    if (method === 'GET' && pathname === '/api/claude/slash-commands') {
      // Only meaningful when the server runs the claude agent. Return [] (not
      // 404) for codex so the client can fetch unconditionally without first
      // branching on agent.
      if (!isClaudeMode()) {
        sendJson(res, 200, { commands: [] });
        return true;
      }
      const search = new URL(req.url || '/', 'http://localhost').searchParams;
      const projectId = (search.get('projectId') || '').trim();
      const project = projectId ? getProject(projectId) : null;
      const projectRoot = project?.path || null;
      const commands = await listClaudeSlashCommands({ projectRoot });
      sendJson(res, 200, { commands });
      return true;
    }

    return false;
  }

  return { preAuthHandle, postAuthHandle };
}
