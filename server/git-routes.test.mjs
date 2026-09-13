import { strict as assert } from 'node:assert';
import http from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { createGitRoutes } from './git-routes.js';

let server;
let baseUrl;
let gitService;
let projects;

function startTestServer(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);
      const ctx = { method: req.method, pathname: url.pathname, parts, url };
      const handled = await routes(req, res, ctx);
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not handled' }));
      }
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

beforeEach(async () => {
  projects = new Map();
  projects.set('p1', { id: 'p1', name: 'one', path: '/repos/one' });
  gitService = {
    status: async () => ({ branch: 'main', ahead: 0, behind: 0, dirty: false, untracked: [], modified: [], staged: [] }),
    diff: async () => ({ diff: 'DIFF' }),
    pull: async () => ({ stdout: 'ok', stderr: '', success: true }),
    commitPush: async () => ({ committed: true, pushed: true, sha: 'abc', stdout: '', stderr: '' }),
    worktrees: async () => ({ worktrees: [{ path: '/repos/one', branch: 'main', head: 'a', bare: false, detached: false, locked: false }] })
  };
  const routes = createGitRoutes({
    gitService,
    getProject: (id) => projects.get(id) || null
  });
  ({ srv: server, baseUrl } = await startTestServer(routes));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(method, pathName, body) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('createGitRoutes throws without gitService', () => {
  assert.throws(() => createGitRoutes({ getProject: () => null }), /gitService is required/);
});

test('createGitRoutes throws without getProject', () => {
  assert.throws(() => createGitRoutes({ gitService: {} }), /getProject is required/);
});

test('non-git path returns false (not handled)', async () => {
  const { status } = await call('GET', '/api/something');
  assert.equal(status, 404); // wrapper "Not handled"
});

test('GET /api/git/status returns status payload', async () => {
  const { status, body } = await call('GET', '/api/git/status?projectId=p1');
  assert.equal(status, 200);
  assert.equal(body.branch, 'main');
  assert.equal(body.dirty, false);
});

test('GET /api/git/status missing projectId → 400', async () => {
  const { status, body } = await call('GET', '/api/git/status');
  assert.equal(status, 400);
  assert.match(body.error, /projectId/);
});

test('GET /api/git/status unknown project → 404', async () => {
  const { status, body } = await call('GET', '/api/git/status?projectId=missing');
  assert.equal(status, 404);
  assert.match(body.error, /Project not found/);
});

test('GET /api/git/status forwards 502 on git failure', async () => {
  gitService.status = async () => {
    const e = new Error('boom'); e.statusCode = 502; throw e;
  };
  const { status, body } = await call('GET', '/api/git/status?projectId=p1');
  assert.equal(status, 502);
  assert.equal(body.error, 'boom');
});

test('GET /api/git/diff passes file + staged params', async () => {
  let observed = null;
  gitService.diff = async (repoPath, opts) => { observed = { repoPath, opts }; return { diff: 'X' }; };
  const { status, body } = await call('GET', '/api/git/diff?projectId=p1&file=foo.js&staged=1');
  assert.equal(status, 200);
  assert.equal(body.diff, 'X');
  assert.equal(observed.repoPath, '/repos/one');
  assert.equal(observed.opts.file, 'foo.js');
  assert.equal(observed.opts.staged, true);
});

test('GET /api/git/diff without staged defaults to false', async () => {
  let observed = null;
  gitService.diff = async (_p, opts) => { observed = opts; return { diff: '' }; };
  await call('GET', '/api/git/diff?projectId=p1');
  assert.equal(observed.staged, false);
});

test('GET /api/git/diff with commit forwards to gitService.diff', async () => {
  let observed = null;
  gitService.diff = async (_p, opts) => { observed = opts; return { diff: 'CD' }; };
  const { status, body } = await call('GET', '/api/git/diff?projectId=p1&file=src%2Fx.js&commit=abcdef0');
  assert.equal(status, 200);
  assert.equal(body.diff, 'CD');
  assert.equal(observed.commit, 'abcdef0');
  assert.equal(observed.file, 'src/x.js');
});

test('GET /api/git/history returns commits + nextCursor', async () => {
  gitService.history = async () => ({
    commits: [{ hash: 'a', parents: [], author: 'A', date: 'd', subject: 's', body: '' }],
    nextCursor: 'b'
  });
  const { status, body } = await call('GET', '/api/git/history?projectId=p1&limit=10');
  assert.equal(status, 200);
  assert.equal(body.commits.length, 1);
  assert.equal(body.nextCursor, 'b');
});

test('GET /api/git/history passes limit + cursor through', async () => {
  let observed = null;
  gitService.history = async (_p, opts) => { observed = opts; return { commits: [], nextCursor: null }; };
  await call('GET', '/api/git/history?projectId=p1&limit=25&cursor=abc1234');
  assert.equal(observed.limit, 25);
  assert.equal(observed.cursor, 'abc1234');
});

test('GET /api/git/history?includeFiles=1 forwards includeFiles=true to service', async () => {
  let observed = null;
  gitService.history = async (_p, opts) => { observed = opts; return { commits: [], nextCursor: null }; };
  await call('GET', '/api/git/history?projectId=p1&includeFiles=1');
  assert.equal(observed.includeFiles, true);
});

test('GET /api/git/history without includeFiles defaults to false', async () => {
  let observed = null;
  gitService.history = async (_p, opts) => { observed = opts; return { commits: [], nextCursor: null }; };
  await call('GET', '/api/git/history?projectId=p1');
  assert.equal(observed.includeFiles, false);
});

test('GET /api/git/history missing projectId → 400', async () => {
  gitService.history = async () => ({ commits: [], nextCursor: null });
  const { status } = await call('GET', '/api/git/history');
  assert.equal(status, 400);
});

test('GET /api/git/history forwards 502 on git failure', async () => {
  gitService.history = async () => {
    const e = new Error('fatal: not a git repo');
    e.statusCode = 502;
    throw e;
  };
  const { status, body } = await call('GET', '/api/git/history?projectId=p1');
  assert.equal(status, 502);
  assert.match(body.error, /not a git repo/);
});

test('GET /api/git/commit-files/:hash returns files for the commit', async () => {
  gitService.commitFiles = async (_p, hash) => ({ hash, files: [{ status: 'M', path: 'a.js' }] });
  const { status, body } = await call('GET', '/api/git/commit-files/abcdef0?projectId=p1');
  assert.equal(status, 200);
  assert.equal(body.hash, 'abcdef0');
  assert.deepEqual(body.files, [{ status: 'M', path: 'a.js' }]);
});

test('GET /api/git/commit-files/:hash missing projectId → 400', async () => {
  gitService.commitFiles = async () => ({ hash: '', files: [] });
  const { status } = await call('GET', '/api/git/commit-files/abcdef0');
  assert.equal(status, 400);
});

test('GET /api/git/commit-files/:hash invalid hash → 400 (forwarded from service)', async () => {
  gitService.commitFiles = async () => {
    const e = new Error('hash must be a valid hex hash');
    e.statusCode = 400;
    throw e;
  };
  const { status, body } = await call('GET', '/api/git/commit-files/zzzz?projectId=p1');
  assert.equal(status, 400);
  assert.match(body.error, /hex hash/);
});

test('POST /api/git/pull returns pull result', async () => {
  const { status, body } = await call('POST', '/api/git/pull', { projectId: 'p1' });
  assert.equal(status, 200);
  assert.equal(body.success, true);
});

test('POST /api/git/pull missing projectId → 400', async () => {
  const { status } = await call('POST', '/api/git/pull', {});
  assert.equal(status, 400);
});

test('POST /api/git/pull unknown project → 404', async () => {
  const { status } = await call('POST', '/api/git/pull', { projectId: 'nope' });
  assert.equal(status, 404);
});

test('POST /api/git/pull forwards gitService error', async () => {
  gitService.pull = async () => { const e = new Error('cant ff'); e.statusCode = 502; throw e; };
  const { status, body } = await call('POST', '/api/git/pull', { projectId: 'p1' });
  assert.equal(status, 502);
  assert.equal(body.error, 'cant ff');
});

test('POST /api/git/commit-push happy path', async () => {
  let observed = null;
  gitService.commitPush = async (repoPath, opts) => { observed = { repoPath, opts }; return { committed: true, pushed: true, sha: 'a', stdout: '', stderr: '' }; };
  const { status, body } = await call('POST', '/api/git/commit-push', { projectId: 'p1', message: 'hi' });
  assert.equal(status, 200);
  assert.equal(body.committed, true);
  assert.equal(body.pushed, true);
  assert.equal(observed.repoPath, '/repos/one');
  assert.equal(observed.opts.message, 'hi');
  assert.equal(observed.opts.addAll, true);
});

test('POST /api/git/commit-push respects addAll=false', async () => {
  let observed = null;
  gitService.commitPush = async (_p, opts) => { observed = opts; return { committed: true, pushed: true, sha: 'a', stdout: '', stderr: '' }; };
  await call('POST', '/api/git/commit-push', { projectId: 'p1', message: 'hi', addAll: false });
  assert.equal(observed.addAll, false);
});

test('POST /api/git/commit-push missing message → 400', async () => {
  const { status, body } = await call('POST', '/api/git/commit-push', { projectId: 'p1' });
  assert.equal(status, 400);
  assert.match(body.error, /message/);
});

test('POST /api/git/commit-push whitespace message → 400', async () => {
  const { status } = await call('POST', '/api/git/commit-push', { projectId: 'p1', message: '   ' });
  assert.equal(status, 400);
});

test('POST /api/git/commit-push unknown project → 404', async () => {
  const { status } = await call('POST', '/api/git/commit-push', { projectId: 'nope', message: 'hi' });
  assert.equal(status, 404);
});

test('POST /api/git/commit-push forwards 502 on push failure', async () => {
  gitService.commitPush = async () => { const e = new Error('rejected'); e.statusCode = 502; throw e; };
  const { status, body } = await call('POST', '/api/git/commit-push', { projectId: 'p1', message: 'hi' });
  assert.equal(status, 502);
  assert.equal(body.error, 'rejected');
});

test('GET /api/git/unknown sub-path returns false (404 from wrapper)', async () => {
  const { status, body } = await call('GET', '/api/git/whatever?projectId=p1');
  assert.equal(status, 404);
  assert.equal(body.error, 'Not handled');
});

test('project without path → 400', async () => {
  projects.set('p2', { id: 'p2', name: 'no-path' });
  const { status, body } = await call('GET', '/api/git/status?projectId=p2');
  assert.equal(status, 400);
  assert.match(body.error, /no path/);
});

test('GET /api/git/worktrees returns worktree list', async () => {
  const { status, body } = await call('GET', '/api/git/worktrees?projectId=p1');
  assert.equal(status, 200);
  assert.equal(body.worktrees.length, 1);
  assert.equal(body.worktrees[0].branch, 'main');
});

test('GET /api/git/worktrees 404s for unknown project', async () => {
  const { status } = await call('GET', '/api/git/worktrees?projectId=nope');
  assert.equal(status, 404);
});

test('GET /api/git/worktrees 400s without projectId', async () => {
  const { status } = await call('GET', '/api/git/worktrees');
  assert.equal(status, 400);
});
