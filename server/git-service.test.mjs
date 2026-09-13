import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createGitService, __test__ } from './git-service.js';

let repoPath;

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'git-svc-'));
  await fs.mkdir(path.join(repoPath, '.git'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true });
});

// Build a mock exec that returns canned responses based on the args[0] (and args[1])
function mockExec(handlers) {
  return async (cmd, args /*, opts */) => {
    assert.equal(cmd, 'git');
    const key = args.join(' ');
    // Try exact match first, then prefix match by joining consecutive args.
    if (handlers[key]) return await handlers[key](args);
    // Try by first arg
    const first = args[0];
    if (handlers[first]) return await handlers[first](args);
    // Default: rev-parse --git-dir → success so assertRepo passes
    if (first === 'rev-parse' && args[1] === '--git-dir') {
      return { stdout: '.git\n', stderr: '', code: 0 };
    }
    throw new Error(`mockExec: no handler for: ${key}`);
  };
}

test('createGitService throws if exec is not a function', () => {
  assert.throws(() => createGitService({ exec: 'no' }), /exec must be a function/);
});

test('status() rejects when repoPath is not absolute', async () => {
  const svc = createGitService({ exec: mockExec({}) });
  await assert.rejects(() => svc.status('relative/path'), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('status() rejects when repoPath does not exist', async () => {
  const svc = createGitService({ exec: mockExec({}) });
  await assert.rejects(() => svc.status(path.join(repoPath, 'nope')), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('status() rejects when not a git repo (rev-parse fails)', async () => {
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse') return { stdout: '', stderr: 'fatal: not a repo', code: 128 };
      return { stdout: '', stderr: '', code: 0 };
    }
  });
  await assert.rejects(() => svc.status(repoPath), (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /not a git repository/);
    return true;
  });
});

test('status() parses clean repo', async () => {
  const svc = createGitService({
    exec: mockExec({
      'status --porcelain=v2 --branch -z': async () => ({
        stdout: '# branch.oid abcd\0# branch.head main\0# branch.ab +0 -0\0',
        stderr: '',
        code: 0
      })
    })
  });
  const s = await svc.status(repoPath);
  assert.equal(s.branch, 'main');
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
  assert.equal(s.dirty, false);
  assert.deepEqual(s.untracked, []);
  assert.deepEqual(s.modified, []);
  assert.deepEqual(s.staged, []);
});

test('status() parses dirty repo with staged + modified + untracked', async () => {
  const svc = createGitService({
    exec: mockExec({
      'status --porcelain=v2 --branch -z': async () => ({
        stdout: [
          '# branch.head feature/x',
          '# branch.ab +2 -1',
          '1 M. N... 100644 100644 100644 aaa aaa staged.txt',
          '1 .M N... 100644 100644 100644 bbb bbb modified.txt',
          '1 MM N... 100644 100644 100644 ccc ccc both.txt',
          '? new.txt',
          ''
        ].join('\0'),
        stderr: '',
        code: 0
      })
    })
  });
  const s = await svc.status(repoPath);
  assert.equal(s.branch, 'feature/x');
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 1);
  assert.equal(s.dirty, true);
  assert.deepEqual(s.untracked, ['new.txt']);
  assert.ok(s.staged.includes('staged.txt'));
  assert.ok(s.staged.includes('both.txt'));
  assert.ok(s.modified.includes('modified.txt'));
  assert.ok(s.modified.includes('both.txt'));
});

test('status() throws gitFailure with 502 when git status fails', async () => {
  const svc = createGitService({
    exec: mockExec({
      'status --porcelain=v2 --branch -z': async () => ({
        stdout: '',
        stderr: 'fatal: bad index',
        code: 128
      })
    })
  });
  await assert.rejects(() => svc.status(repoPath), (err) => {
    assert.equal(err.statusCode, 502);
    assert.match(err.message, /bad index/);
    return true;
  });
});

test('diff() returns diff text', async () => {
  const svc = createGitService({
    exec: mockExec({
      diff: async () => ({ stdout: 'diff --git a/x b/x\n+hello\n', stderr: '', code: 0 })
    })
  });
  const r = await svc.diff(repoPath);
  assert.match(r.diff, /diff --git/);
});

test('diff() supports staged option (uses --cached)', async () => {
  let observedArgs = null;
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'diff') {
        observedArgs = args;
        return { stdout: 'staged-diff', stderr: '', code: 0 };
      }
      throw new Error('unexpected');
    }
  });
  await svc.diff(repoPath, { staged: true });
  assert.ok(observedArgs.includes('--cached'));
});

test('diff() rejects file starting with -', async () => {
  const svc = createGitService({ exec: mockExec({}) });
  await assert.rejects(() => svc.diff(repoPath, { file: '--evil' }), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('diff() truncates output beyond 1MB with marker', async () => {
  const big = 'a'.repeat(__test__.DIFF_TRUNCATE_BYTES + 100);
  const svc = createGitService({
    exec: mockExec({
      diff: async () => ({ stdout: big, stderr: '', code: 0 })
    })
  });
  const r = await svc.diff(repoPath);
  assert.ok(r.diff.endsWith(__test__.TRUNCATE_MARKER));
  assert.ok(r.diff.length <= __test__.DIFF_TRUNCATE_BYTES + __test__.TRUNCATE_MARKER.length + 8);
});

test('pull() returns success=true on code 0', async () => {
  const svc = createGitService({
    exec: mockExec({
      pull: async () => ({ stdout: 'Already up to date.', stderr: '', code: 0 })
    })
  });
  const r = await svc.pull(repoPath);
  assert.equal(r.success, true);
  assert.match(r.stdout, /up to date/);
});

test('pull() returns success=false on non-zero code', async () => {
  const svc = createGitService({
    exec: mockExec({
      pull: async () => ({ stdout: '', stderr: 'fatal: not possible to fast-forward', code: 1 })
    })
  });
  const r = await svc.pull(repoPath);
  assert.equal(r.success, false);
  assert.match(r.stderr, /fast-forward/);
});

test('pull() uses --ff-only', async () => {
  let observed = null;
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse') return { stdout: '.git', stderr: '', code: 0 };
      observed = args;
      return { stdout: '', stderr: '', code: 0 };
    }
  });
  await svc.pull(repoPath);
  assert.deepEqual(observed, ['pull', '--ff-only']);
});

test('commitPush() rejects empty message', async () => {
  const svc = createGitService({ exec: mockExec({}) });
  await assert.rejects(() => svc.commitPush(repoPath, { message: '   ' }), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('commitPush() rejects when nothing to commit', async () => {
  const svc = createGitService({
    exec: mockExec({
      'status --porcelain': async () => ({ stdout: '', stderr: '', code: 0 })
    })
  });
  await assert.rejects(() => svc.commitPush(repoPath, { message: 'x' }), (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /nothing to commit/);
    return true;
  });
});

test('commitPush() runs add -A, commit, push and returns sha', async () => {
  const calls = [];
  const svc = createGitService({
    exec: async (cmd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'status' && args[1] === '--porcelain') return { stdout: ' M foo.txt\n', stderr: '', code: 0 };
      if (args[0] === 'add') return { stdout: '', stderr: '', code: 0 };
      if (args[0] === 'commit') return { stdout: '[main abc] msg', stderr: '', code: 0 };
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: 'deadbeef\n', stderr: '', code: 0 };
      if (args[0] === 'push') return { stdout: 'pushed', stderr: '', code: 0 };
      throw new Error('unexpected ' + args.join(' '));
    }
  });
  const r = await svc.commitPush(repoPath, { message: 'hello' });
  assert.equal(r.committed, true);
  assert.equal(r.pushed, true);
  assert.equal(r.sha, 'deadbeef');
  assert.ok(calls.some((c) => c === 'add -A'));
  assert.ok(calls.some((c) => c.startsWith('commit -m')));
  assert.ok(calls.some((c) => c === 'push'));
});

test('commitPush() skips add when addAll=false', async () => {
  let sawAdd = false;
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'status' && args[1] === '--porcelain') return { stdout: 'M  foo\n', stderr: '', code: 0 };
      if (args[0] === 'add') { sawAdd = true; return { stdout: '', stderr: '', code: 0 }; }
      if (args[0] === 'commit') return { stdout: '', stderr: '', code: 0 };
      if (args[0] === 'rev-parse') return { stdout: 'sha', stderr: '', code: 0 };
      if (args[0] === 'push') return { stdout: '', stderr: '', code: 0 };
      throw new Error('unexpected');
    }
  });
  await svc.commitPush(repoPath, { message: 'hi', addAll: false });
  assert.equal(sawAdd, false);
});

test('commitPush() with paths: stages only those files (no -A)', async () => {
  const addCalls = [];
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'status' && args[1] === '--porcelain') return { stdout: ' M a\n M b\n?? c\n', stderr: '', code: 0 };
      if (args[0] === 'add') { addCalls.push(args.slice(1)); return { stdout: '', stderr: '', code: 0 }; }
      if (args[0] === 'commit') return { stdout: '', stderr: '', code: 0 };
      if (args[0] === 'rev-parse') return { stdout: 'sha\n', stderr: '', code: 0 };
      if (args[0] === 'push') return { stdout: '', stderr: '', code: 0 };
      throw new Error('unexpected: ' + args.join(' '));
    }
  });
  const result = await svc.commitPush(repoPath, { message: 'partial', paths: ['a', 'c'] });
  assert.equal(result.committed, true);
  assert.equal(addCalls.length, 1);
  // Expect git add -- a c (with -- separator to avoid flag-injection)
  assert.deepEqual(addCalls[0], ['--', 'a', 'c']);
});

test('commitPush() rejects path containing leading dash without --', async () => {
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'status' && args[1] === '--porcelain') return { stdout: ' M f\n', stderr: '', code: 0 };
      throw new Error('should not reach exec');
    }
  });
  // This path attempts flag injection — must be refused
  await assert.rejects(
    () => svc.commitPush(repoPath, { message: 'hi', paths: ['--upload-pack=evil'] }),
    (error) => error.statusCode === 400
  );
});

test('commitPush() accepts paths with spaces and chinese chars', async () => {
  const addCalls = [];
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'status' && args[1] === '--porcelain') return { stdout: ' M f\n', stderr: '', code: 0 };
      if (args[0] === 'add') { addCalls.push(args.slice(1)); return { stdout: '', stderr: '', code: 0 }; }
      if (args[0] === 'commit') return { stdout: '', stderr: '', code: 0 };
      if (args[0] === 'rev-parse') return { stdout: 'sha\n', stderr: '', code: 0 };
      if (args[0] === 'push') return { stdout: '', stderr: '', code: 0 };
      throw new Error('unexpected');
    }
  });
  await svc.commitPush(repoPath, { message: 'x', paths: ['has space.txt', '中文/文件.md'] });
  assert.deepEqual(addCalls[0], ['--', 'has space.txt', '中文/文件.md']);
});

test('commitPush() rejects path containing NUL or path traversal', async () => {
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'status' && args[1] === '--porcelain') return { stdout: ' M f\n', stderr: '', code: 0 };
      throw new Error('should not reach exec');
    }
  });
  await assert.rejects(
    () => svc.commitPush(repoPath, { message: 'hi', paths: ['../evil'] }),
    (error) => error.statusCode === 400
  );
  await assert.rejects(
    () => svc.commitPush(repoPath, { message: 'hi', paths: ['..\\evil'] }),
    (error) => error.statusCode === 400
  );
  await assert.rejects(
    () => svc.commitPush(repoPath, { message: 'hi', paths: ['file evil'] }),
    (error) => error.statusCode === 400
  );
});

test('commitPush() with empty paths array falls back to addAll behavior', async () => {
  let addedAll = false;
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'status' && args[1] === '--porcelain') return { stdout: ' M f\n', stderr: '', code: 0 };
      if (args[0] === 'add' && args[1] === '-A') { addedAll = true; return { stdout: '', stderr: '', code: 0 }; }
      if (args[0] === 'commit') return { stdout: '', stderr: '', code: 0 };
      if (args[0] === 'rev-parse') return { stdout: 'sha\n', stderr: '', code: 0 };
      if (args[0] === 'push') return { stdout: '', stderr: '', code: 0 };
      throw new Error('unexpected');
    }
  });
  await svc.commitPush(repoPath, { message: 'x', paths: [] });
  assert.equal(addedAll, true);
});

test('commitPush() reports pushed=false when push fails (no rollback)', async () => {
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'status' && args[1] === '--porcelain') return { stdout: ' M f\n', stderr: '', code: 0 };
      if (args[0] === 'add') return { stdout: '', stderr: '', code: 0 };
      if (args[0] === 'commit') return { stdout: '', stderr: '', code: 0 };
      if (args[0] === 'rev-parse') return { stdout: 'sha\n', stderr: '', code: 0 };
      if (args[0] === 'push') return { stdout: '', stderr: 'rejected', code: 1 };
      throw new Error('unexpected');
    }
  });
  const r = await svc.commitPush(repoPath, { message: 'hi' });
  assert.equal(r.committed, true);
  assert.equal(r.pushed, false);
  assert.match(r.stderr, /rejected/);
});

test('commitPush() throws 502 when commit itself fails', async () => {
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'status' && args[1] === '--porcelain') return { stdout: ' M f\n', stderr: '', code: 0 };
      if (args[0] === 'add') return { stdout: '', stderr: '', code: 0 };
      if (args[0] === 'commit') return { stdout: '', stderr: 'pre-commit failed', code: 1 };
      throw new Error('unexpected');
    }
  });
  await assert.rejects(() => svc.commitPush(repoPath, { message: 'hi' }), (err) => {
    assert.equal(err.statusCode, 502);
    assert.match(err.message, /pre-commit failed/);
    return true;
  });
});

test('commitPush() sanitizes control chars from message', async () => {
  let observedMsg = null;
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'status' && args[1] === '--porcelain') return { stdout: ' M f\n', stderr: '', code: 0 };
      if (args[0] === 'add') return { stdout: '', stderr: '', code: 0 };
      if (args[0] === 'commit') {
        observedMsg = args[2];
        return { stdout: '', stderr: '', code: 0 };
      }
      if (args[0] === 'rev-parse') return { stdout: 'sha', stderr: '', code: 0 };
      if (args[0] === 'push') return { stdout: '', stderr: '', code: 0 };
      throw new Error('unexpected');
    }
  });
  await svc.commitPush(repoPath, { message: 'hello\x00\x07world\x1B[31m' });
  assert.equal(observedMsg, 'helloworld[31m');
});

// --- history ------------------------------------------------------------

const SEP_F = '\x1f';
const SEP_R = '\x1e';

function makeHistoryStdout(commits) {
  return commits
    .map((c) => [c.hash, c.parents || '', c.author || 'A', c.date || '2026-05-01T00:00:00+00:00', c.subject || 's', c.body || ''].join(SEP_F) + SEP_R)
    .join('');
}

test('history() parses git log into commit records', async () => {
  let observedArgs = null;
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'log') {
        observedArgs = args;
        return {
          stdout: makeHistoryStdout([
            { hash: 'aaaaaaaa', parents: 'bbbbbbbb', author: 'Alice', date: '2026-05-01T10:00:00+00:00', subject: 'first', body: 'extra info' },
            { hash: 'bbbbbbbb', parents: 'cccccccc', author: 'Bob', date: '2026-04-30T09:00:00+00:00', subject: 'second', body: '' }
          ]),
          stderr: '',
          code: 0
        };
      }
      throw new Error('unexpected');
    }
  });
  const r = await svc.history(repoPath, { limit: 50 });
  assert.equal(r.commits.length, 2);
  assert.equal(r.commits[0].hash, 'aaaaaaaa');
  assert.deepEqual(r.commits[0].parents, ['bbbbbbbb']);
  assert.equal(r.commits[0].author, 'Alice');
  assert.equal(r.commits[0].subject, 'first');
  assert.equal(r.commits[0].body, 'extra info');
  assert.equal(r.nextCursor, null);
  // -n limit+1 is fetched so we can determine hasMore
  assert.ok(observedArgs.includes('-n'));
  assert.ok(observedArgs.includes('51'));
});

test('history() sets nextCursor when more pages remain', async () => {
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'log') {
        return {
          stdout: makeHistoryStdout([
            { hash: 'a1', parents: 'a2' },
            { hash: 'a2', parents: 'a3' },
            { hash: 'a3', parents: '' }
          ]),
          stderr: '',
          code: 0
        };
      }
      throw new Error('unexpected');
    }
  });
  const r = await svc.history(repoPath, { limit: 2 });
  assert.equal(r.commits.length, 2);
  assert.deepEqual(r.commits.map((c) => c.hash), ['a1', 'a2']);
  assert.equal(r.nextCursor, 'a3');
});

test('history({includeFiles:true}) returns commits with files in one call', async () => {
  let observedArgs = null;
  // Stream shape: <RS><hash>\x1f<P>\x1f<A>\x1f<D>\x1f<S>\nM\tfile.js\nA\tnew.md\n  for two commits
  const stream =
    `${SEP_R}h1${SEP_F}h0${SEP_F}A${SEP_F}d1${SEP_F}first\nM\tfile.js\nA\tnew.md\n` +
    `${SEP_R}h2${SEP_F}${SEP_F}A${SEP_F}d2${SEP_F}second\nR100\told\tnew\n`;
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'log') {
        observedArgs = args;
        return { stdout: stream, stderr: '', code: 0 };
      }
      throw new Error('unexpected');
    }
  });
  const r = await svc.history(repoPath, { limit: 50, includeFiles: true });
  assert.equal(r.commits.length, 2);
  assert.equal(r.commits[0].hash, 'h1');
  assert.deepEqual(r.commits[0].files, [
    { status: 'M', path: 'file.js' },
    { status: 'A', path: 'new.md' }
  ]);
  assert.equal(r.commits[1].hash, 'h2');
  assert.deepEqual(r.commits[1].files, [
    { status: 'R', path: 'new', from: 'old' }
  ]);
  // --name-status must be in the git args
  assert.ok(observedArgs.includes('--name-status'));
});

test('history({includeFiles:true}) handles commits with no file changes', async () => {
  const stream = `${SEP_R}h1${SEP_F}h0${SEP_F}A${SEP_F}d1${SEP_F}empty\n`;
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'log') return { stdout: stream, stderr: '', code: 0 };
      throw new Error('unexpected');
    }
  });
  const r = await svc.history(repoPath, { includeFiles: true });
  assert.equal(r.commits.length, 1);
  assert.deepEqual(r.commits[0].files, []);
});

test('history({includeFiles:false}) keeps the original API + body field', async () => {
  let observedArgs = null;
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'log') {
        observedArgs = args;
        return {
          stdout: makeHistoryStdout([
            { hash: 'a', parents: '', body: 'multi\nline\nbody' }
          ]),
          stderr: '', code: 0
        };
      }
      throw new Error('unexpected');
    }
  });
  const r = await svc.history(repoPath, { limit: 10 });
  assert.equal(r.commits[0].body, 'multi\nline\nbody');
  assert.ok(r.commits[0].files === undefined);
  assert.equal(observedArgs.includes('--name-status'), false);
});

test('history() rejects malformed cursor', async () => {
  const svc = createGitService({ exec: mockExec({}) });
  await assert.rejects(() => svc.history(repoPath, { cursor: 'not-hex!!' }), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('history() passes cursor to git log', async () => {
  let observed = null;
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'log') { observed = args; return { stdout: '', stderr: '', code: 0 }; }
      throw new Error('unexpected');
    }
  });
  await svc.history(repoPath, { cursor: 'abcdef0' });
  assert.ok(observed.includes('abcdef0'));
});

test('history() caps limit at 500 and floors at 1', async () => {
  let lastN;
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'log') {
        const nIdx = args.indexOf('-n');
        lastN = Number(args[nIdx + 1]);
        return { stdout: '', stderr: '', code: 0 };
      }
      throw new Error('unexpected');
    }
  });
  await svc.history(repoPath, { limit: 99999 });
  assert.equal(lastN, 501, 'caps at 500 (+1 for nextCursor probe)');
  await svc.history(repoPath, { limit: -5 });
  assert.equal(lastN, 2, 'floors negative/zero to 1 (+1 for nextCursor probe)');
});

test('commitFiles() parses --name-status output', async () => {
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'show') {
        return {
          stdout: 'M\tsrc/foo.js\nA\tdocs/new.md\nD\told.txt\n',
          stderr: '', code: 0
        };
      }
      throw new Error('unexpected');
    }
  });
  const r = await svc.commitFiles(repoPath, 'abcdef0');
  assert.equal(r.hash, 'abcdef0');
  assert.deepEqual(r.files, [
    { status: 'M', path: 'src/foo.js' },
    { status: 'A', path: 'docs/new.md' },
    { status: 'D', path: 'old.txt' }
  ]);
});

test('commitFiles() parses rename + copy as single rows with from-path', async () => {
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'show') {
        return {
          stdout: [
            'M\tunchanged.js',
            'R100\told/path.js\tnew/path.js',
            'C75\tsrc/origin.md\tsrc/clone.md'
          ].join('\n') + '\n',
          stderr: '', code: 0
        };
      }
      throw new Error('unexpected');
    }
  });
  const r = await svc.commitFiles(repoPath, 'abcdef0');
  assert.deepEqual(r.files, [
    { status: 'M', path: 'unchanged.js' },
    { status: 'R', path: 'new/path.js', from: 'old/path.js' },
    { status: 'C', path: 'src/clone.md', from: 'src/origin.md' }
  ]);
});

test('commitFiles() rejects malformed hash', async () => {
  const svc = createGitService({ exec: mockExec({}) });
  await assert.rejects(() => svc.commitFiles(repoPath, '../etc/passwd'), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('diff() with commit uses git show', async () => {
  let observed = null;
  const svc = createGitService({
    exec: async (cmd, args) => {
      if (args[0] === 'rev-parse') return { stdout: '.git', stderr: '', code: 0 };
      if (args[0] === 'show') { observed = args; return { stdout: 'diff --git a/x b/x\n+hi', stderr: '', code: 0 }; }
      throw new Error('unexpected');
    }
  });
  const r = await svc.diff(repoPath, { commit: 'abcdef0', file: 'src/x.js' });
  assert.match(r.diff, /diff --git/);
  assert.ok(observed.includes('abcdef0'));
  assert.ok(observed.includes('--'));
  assert.ok(observed.includes('src/x.js'));
});

test('diff() rejects commit with invalid hash', async () => {
  const svc = createGitService({ exec: mockExec({}) });
  await assert.rejects(() => svc.diff(repoPath, { commit: 'xyz!!' }), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('diff() rejects commit + staged combination', async () => {
  const svc = createGitService({ exec: mockExec({}) });
  await assert.rejects(() => svc.diff(repoPath, { commit: 'abcdef0', staged: true }), (err) => {
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test('sanitizeMessage utility strips control chars and trims', () => {
  assert.equal(__test__.sanitizeMessage('  hi\x00there  '), 'hithere');
  assert.equal(__test__.sanitizeMessage(null), '');
  assert.equal(__test__.sanitizeMessage('keep\nnewline'), 'keep\nnewline');
});

test('truncateDiff utility leaves small input untouched', () => {
  assert.equal(__test__.truncateDiff('small'), 'small');
});

test('worktrees() parses porcelain output into structured list', async () => {
  const stdout = [
    'worktree /repo/main',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /repo/wt-feature',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/feat/connection-recovery',
    '',
    'worktree /repo/wt-detached',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
    'locked',
    ''
  ].join('\n');
  const svc = createGitService({
    exec: mockExec({
      worktree: async () => ({ stdout, stderr: '', code: 0 })
    })
  });
  const { worktrees } = await svc.worktrees(repoPath);
  assert.equal(worktrees.length, 3);
  assert.deepEqual(worktrees[0], {
    path: '/repo/main',
    branch: 'main',
    head: '1111111111111111111111111111111111111111',
    bare: false,
    detached: false,
    locked: false
  });
  assert.equal(worktrees[1].branch, 'feat/connection-recovery');
  assert.equal(worktrees[2].branch, null);
  assert.equal(worktrees[2].detached, true);
  assert.equal(worktrees[2].locked, true);
});

test('worktrees() handles a single bare repo entry', () => {
  const parsed = __test__.parseWorktreePorcelain('worktree /repo/bare\nbare\n');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].bare, true);
  assert.equal(parsed[0].branch, null);
});

test('parseWorktreePorcelain returns [] for empty input', () => {
  assert.deepEqual(__test__.parseWorktreePorcelain(''), []);
  assert.deepEqual(__test__.parseWorktreePorcelain(null), []);
});
