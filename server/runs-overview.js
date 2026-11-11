import path from 'node:path';

// One list of the conversations that need attention or are working: turns
// waiting on an approval, running turns and conversations with queued
// messages. The phone shows it as the "进行中" sheet, so each entry carries
// what is needed to recognize it without opening it: title, project, the
// worktree it runs in and that worktree's branch.

const STATUS_ORDER = { approval: 0, running: 1, queued: 2 };

function worktreeLabel(cwd, projectPath) {
  if (!cwd || !projectPath) return null;
  const a = path.resolve(cwd);
  const b = path.resolve(projectPath);
  return a === b ? null : path.basename(a);
}

export async function buildRunsOverview({
  activeRuns = [],
  approvals = [],
  queues = [],
  getSession = () => null,
  getProject = () => null,
  readBranch = async () => null
}) {
  const bySession = new Map();
  const entryFor = (sessionId) => {
    if (!sessionId) return null;
    if (!bySession.has(sessionId)) {
      bySession.set(sessionId, { sessionId, status: null, startedAt: null, approvals: 0, queued: 0 });
    }
    return bySession.get(sessionId);
  };

  for (const run of activeRuns) {
    const entry = entryFor(run.sessionId || run.previousSessionId);
    if (!entry) continue;
    entry.status ||= 'running';
    if (run.startedAt && (!entry.startedAt || run.startedAt < entry.startedAt)) entry.startedAt = run.startedAt;
  }
  for (const approval of approvals) {
    const entry = entryFor(approval.sessionId);
    if (!entry) continue;
    entry.approvals += 1;
  }
  for (const queue of queues) {
    const entry = entryFor(queue.sessionId);
    if (!entry) continue;
    entry.queued += queue.drafts?.length || 0;
  }

  const branchByCwd = new Map();
  const entries = await Promise.all([...bySession.values()].map(async (entry) => {
    const session = getSession(entry.sessionId) || {};
    const projectId = session.projectId || null;
    const project = projectId ? getProject(projectId) : null;
    const cwd = session.cwd || project?.path || null;
    if (cwd && !branchByCwd.has(cwd)) branchByCwd.set(cwd, readBranch(cwd));
    const status = entry.approvals ? 'approval' : entry.status || (entry.queued ? 'queued' : 'running');
    return {
      sessionId: entry.sessionId,
      status,
      title: session.title || '未命名会话',
      projectId,
      projectName: project?.name || (cwd ? path.basename(cwd) : null),
      worktree: worktreeLabel(cwd, project?.path),
      branch: cwd ? await branchByCwd.get(cwd) : null,
      startedAt: entry.startedAt,
      approvals: entry.approvals,
      queued: entry.queued
    };
  }));

  return entries.sort((a, b) =>
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    String(a.startedAt || '').localeCompare(String(b.startedAt || ''))
  );
}

// Branch lookups shell out to git; the sheet polls every few seconds, so
// remember each directory's answer briefly.
export function createBranchReader(currentBranch, { ttlMs = 10000, now = () => Date.now() } = {}) {
  const cache = new Map();
  return async (cwd) => {
    const hit = cache.get(cwd);
    if (hit && now() - hit.at < ttlMs) return hit.branch;
    const branch = await currentBranch(cwd);
    cache.set(cwd, { branch, at: now() });
    return branch;
  };
}

export function createRunsOverviewRoutes(deps) {
  return async function handle(req, res, { method, pathname }, sendJson) {
    if (method !== 'GET' || pathname !== '/api/runs/overview') return false;
    const runs = await buildRunsOverview({
      activeRuns: deps.getActiveRuns(),
      approvals: deps.listPendingApprovals(),
      queues: deps.listPendingQueues(),
      getSession: deps.getSession,
      getProject: deps.getProject,
      readBranch: deps.readBranch
    });
    sendJson(res, 200, { runs });
    return true;
  };
}
