import { readBody, sendJson } from './http-utils.js';

export function createGitRoutes({ gitService, getProject }) {
  if (!gitService) throw new Error('createGitRoutes: gitService is required');
  if (typeof getProject !== 'function') throw new Error('createGitRoutes: getProject is required');

  function resolveProject(req, res, projectId) {
    if (!projectId || typeof projectId !== 'string') {
      sendJson(res, 400, { error: 'projectId is required' });
      return null;
    }
    const project = getProject(projectId);
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return null;
    }
    if (!project.path) {
      sendJson(res, 400, { error: 'Project has no path' });
      return null;
    }
    return project;
  }

  function handleGitError(res, error, fallback) {
    const status = error.statusCode || 502;
    sendJson(res, status, { error: error.message || fallback });
  }

  return async function handle(req, res, ctx) {
    const { method, pathname, parts } = ctx;

    if (!(parts.length >= 2 && parts[0] === 'api' && parts[1] === 'git')) {
      return false;
    }

    const url = new URL(req.url, 'http://127.0.0.1');

    // GET /api/git/status?projectId=...
    if (method === 'GET' && pathname === '/api/git/status') {
      const projectId = url.searchParams.get('projectId');
      const project = resolveProject(req, res, projectId);
      if (!project) return true;
      try {
        const result = await gitService.status(project.path);
        sendJson(res, 200, result);
      } catch (error) {
        handleGitError(res, error, 'git status failed');
      }
      return true;
    }

    // GET /api/git/worktrees?projectId=...
    if (method === 'GET' && pathname === '/api/git/worktrees') {
      const projectId = url.searchParams.get('projectId');
      const project = resolveProject(req, res, projectId);
      if (!project) return true;
      try {
        const result = await gitService.worktrees(project.path);
        sendJson(res, 200, result);
      } catch (error) {
        handleGitError(res, error, 'git worktree list failed');
      }
      return true;
    }

    // GET /api/git/diff?projectId=...&file=...&staged=1&commit=...
    if (method === 'GET' && pathname === '/api/git/diff') {
      const projectId = url.searchParams.get('projectId');
      const project = resolveProject(req, res, projectId);
      if (!project) return true;
      const file = url.searchParams.get('file') || undefined;
      const stagedRaw = url.searchParams.get('staged');
      const staged = stagedRaw === '1' || stagedRaw === 'true';
      const commit = url.searchParams.get('commit') || undefined;
      try {
        const result = await gitService.diff(project.path, { file, staged, commit });
        sendJson(res, 200, result);
      } catch (error) {
        handleGitError(res, error, 'git diff failed');
      }
      return true;
    }

    // GET /api/git/history?projectId=...&limit=...&cursor=...&includeFiles=1
    if (method === 'GET' && pathname === '/api/git/history') {
      const projectId = url.searchParams.get('projectId');
      const project = resolveProject(req, res, projectId);
      if (!project) return true;
      const limit = Number(url.searchParams.get('limit')) || undefined;
      const cursor = url.searchParams.get('cursor') || undefined;
      const includeFilesRaw = url.searchParams.get('includeFiles');
      const includeFiles = includeFilesRaw === '1' || includeFilesRaw === 'true';
      try {
        const result = await gitService.history(project.path, { limit, cursor, includeFiles });
        sendJson(res, 200, result);
      } catch (error) {
        handleGitError(res, error, 'git history failed');
      }
      return true;
    }

    // GET /api/git/commit-files/:hash?projectId=...
    if (method === 'GET' && parts.length === 4 && parts[2] === 'commit-files') {
      const projectId = url.searchParams.get('projectId');
      const project = resolveProject(req, res, projectId);
      if (!project) return true;
      const hash = parts[3];
      try {
        const result = await gitService.commitFiles(project.path, hash);
        sendJson(res, 200, result);
      } catch (error) {
        handleGitError(res, error, 'git commit-files failed');
      }
      return true;
    }

    // POST /api/git/pull
    if (method === 'POST' && pathname === '/api/git/pull') {
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message || 'Invalid body' });
        return true;
      }
      const project = resolveProject(req, res, body.projectId);
      if (!project) return true;
      try {
        const result = await gitService.pull(project.path);
        sendJson(res, 200, result);
      } catch (error) {
        handleGitError(res, error, 'git pull failed');
      }
      return true;
    }

    // POST /api/git/commit-push
    if (method === 'POST' && pathname === '/api/git/commit-push') {
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message || 'Invalid body' });
        return true;
      }
      const project = resolveProject(req, res, body.projectId);
      if (!project) return true;
      if (!body.message || typeof body.message !== 'string' || !body.message.trim()) {
        sendJson(res, 400, { error: 'message is required' });
        return true;
      }
      const addAll = body.addAll !== false;
      const paths = Array.isArray(body.paths) ? body.paths : undefined;
      try {
        const result = await gitService.commitPush(project.path, { message: body.message, addAll, paths });
        sendJson(res, 200, result);
      } catch (error) {
        handleGitError(res, error, 'git commit-push failed');
      }
      return true;
    }

    return false;
  };
}
