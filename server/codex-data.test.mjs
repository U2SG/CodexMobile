import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mergeProjectSources,
  normalizeComparablePath,
  parseSessionMetadata,
  upsertLatestSession,
  sanitizeVisibleUserMessage,
  resolveProjectRoot
} from './codex-data.js';

function makeSession({ id, projectId, updatedAt, filePath, messageCount }) {
  return { id, projectId, updatedAt, filePath, messageCount };
}

test('normalizeComparablePath treats Windows device paths like normal paths', () => {
  if (process.platform !== 'win32') {
    return;
  }
  assert.equal(
    normalizeComparablePath('\\\\?\\D:\\startrips'),
    normalizeComparablePath('D:\\startrips')
  );
});

test('mergeProjectSources preserves workspace order and appends config-only projects', () => {
  const projects = mergeProjectSources(
    [{ path: 'D:\\one', label: 'One' }],
    [
      { path: 'D:\\one', trustLevel: 'trusted' },
      { path: 'D:\\startrips', trustLevel: 'trusted' }
    ]
  );

  assert.deepEqual(projects, [
    { path: 'D:\\one', trustLevel: 'trusted', label: 'One' },
    { path: 'D:\\startrips', trustLevel: 'trusted', label: null }
  ]);
});

test('upsertLatestSession deduplicates resumed rollouts by id, keeping the later updatedAt', () => {
  // Reproduces the picture-project scenario: a resumed rollout file writes its
  // parent session's id in a later session_meta entry, so parseSessionMetadata
  // returns the parent id even though the file is physically separate. Both
  // parses must collapse into a single cache entry — the resume file (newer
  // updatedAt, full message increments).
  const project = { id: 'picture' };
  const sessionsByProject = new Map();
  const sessionById = new Map();

  const original = makeSession({
    id: 'parent-id',
    projectId: 'picture',
    updatedAt: '2026-05-16T14:31:04.565Z',
    filePath: 'parent.jsonl',
    messageCount: 21
  });
  const resumed = makeSession({
    id: 'parent-id',
    projectId: 'picture',
    updatedAt: '2026-05-16T15:47:45.896Z',
    filePath: 'resume.jsonl',
    messageCount: 25
  });

  upsertLatestSession(original, sessionsByProject, sessionById, project);
  upsertLatestSession(resumed, sessionsByProject, sessionById, project);

  const list = sessionsByProject.get('picture');
  assert.equal(list.length, 1, 'duplicate id must collapse');
  assert.equal(list[0].filePath, 'resume.jsonl', 'kept entry should be the resume file');
  assert.equal(list[0].messageCount, 25, 'resume-period messages must be preserved');
  assert.equal(sessionById.get('parent-id'), list[0]);
});

test('upsertLatestSession ignores an older entry when a newer one is already stored', () => {
  const project = { id: 'picture' };
  const sessionsByProject = new Map();
  const sessionById = new Map();

  const newer = makeSession({
    id: 'parent-id',
    projectId: 'picture',
    updatedAt: '2026-05-16T15:47:45.896Z',
    filePath: 'resume.jsonl',
    messageCount: 25
  });
  const older = makeSession({
    id: 'parent-id',
    projectId: 'picture',
    updatedAt: '2026-05-16T14:31:04.565Z',
    filePath: 'parent.jsonl',
    messageCount: 21
  });

  upsertLatestSession(newer, sessionsByProject, sessionById, project);
  upsertLatestSession(older, sessionsByProject, sessionById, project);

  const list = sessionsByProject.get('picture');
  assert.equal(list.length, 1);
  assert.equal(list[0].filePath, 'resume.jsonl', 'order of arrival must not matter');
  assert.equal(list[0].messageCount, 25);
});

test('upsertLatestSession appends distinct ids without disturbing existing entries', () => {
  const project = { id: 'picture' };
  const sessionsByProject = new Map();
  const sessionById = new Map();

  const a = makeSession({
    id: 'session-a',
    projectId: 'picture',
    updatedAt: '2026-05-16T10:00:00.000Z',
    filePath: 'a.jsonl',
    messageCount: 10
  });
  const b = makeSession({
    id: 'session-b',
    projectId: 'picture',
    updatedAt: '2026-05-16T11:00:00.000Z',
    filePath: 'b.jsonl',
    messageCount: 7
  });

  upsertLatestSession(a, sessionsByProject, sessionById, project);
  upsertLatestSession(b, sessionsByProject, sessionById, project);

  const list = sessionsByProject.get('picture');
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((s) => s.id).sort(), ['session-a', 'session-b']);
});

test('upsertLatestSession migrates a dup across projects when the resume file changes cwd', () => {
  // Defensive: a resume file pointing at a different cwd should not leave a
  // ghost entry under the old project. The upsert removes it from the old
  // project's list before inserting into the new one.
  const oldProject = { id: 'old-project' };
  const newProject = { id: 'new-project' };
  const sessionsByProject = new Map();
  const sessionById = new Map();

  const original = makeSession({
    id: 'parent-id',
    projectId: 'old-project',
    updatedAt: '2026-05-16T10:00:00.000Z',
    filePath: 'old.jsonl',
    messageCount: 5
  });
  const resumed = makeSession({
    id: 'parent-id',
    projectId: 'new-project',
    updatedAt: '2026-05-16T11:00:00.000Z',
    filePath: 'new.jsonl',
    messageCount: 8
  });

  upsertLatestSession(original, sessionsByProject, sessionById, oldProject);
  upsertLatestSession(resumed, sessionsByProject, sessionById, newProject);

  assert.equal(sessionsByProject.get('old-project').length, 0);
  assert.equal(sessionsByProject.get('new-project').length, 1);
  assert.equal(sessionsByProject.get('new-project')[0].filePath, 'new.jsonl');
});

test('upsertLatestSession treats missing updatedAt as zero and prefers any dated entry', () => {
  const project = { id: 'picture' };
  const sessionsByProject = new Map();
  const sessionById = new Map();

  const undated = makeSession({
    id: 'parent-id',
    projectId: 'picture',
    updatedAt: null,
    filePath: 'undated.jsonl',
    messageCount: 0
  });
  const dated = makeSession({
    id: 'parent-id',
    projectId: 'picture',
    updatedAt: '2026-05-16T15:00:00.000Z',
    filePath: 'dated.jsonl',
    messageCount: 3
  });

  upsertLatestSession(undated, sessionsByProject, sessionById, project);
  upsertLatestSession(dated, sessionsByProject, sessionById, project);

  const list = sessionsByProject.get('picture');
  assert.equal(list.length, 1);
  assert.equal(list[0].filePath, 'dated.jsonl');
});

test('sanitizeVisibleUserMessage drops Claude system-noise blocks so they never render', () => {
  // Background task completion / local-command stdout must not become bubbles.
  assert.equal(
    sanitizeVisibleUserMessage('<task-notification>\n<status>completed</status>\n</task-notification>'),
    ''
  );
  assert.equal(sanitizeVisibleUserMessage('<local-command-stdout>foo</local-command-stdout>'), '');
  assert.equal(sanitizeVisibleUserMessage('<bash-stderr>boom</bash-stderr>'), '');
});

test('sanitizeVisibleUserMessage keeps real user text intact', () => {
  assert.equal(sanitizeVisibleUserMessage('帮我看一下这个 bug'), '帮我看一下这个 bug');
  // A task-notification mentioned mid-sentence by the user is real content.
  assert.equal(
    sanitizeVisibleUserMessage('为什么会出现 <task-notification> 这种东西'),
    '为什么会出现 <task-notification> 这种东西'
  );
});

test('resolveProjectRoot maps a git linked worktree back to its main repo root', () => {
  // A worktree session must group with the main project instead of spawning a
  // phantom project per worktree. Simulate git's on-disk worktree layout:
  //   <main>/.git/                        (real repo)
  //   <main>/.git/worktrees/wt/commondir  -> "../.."  (points back to <main>/.git)
  //   <wt>/.git                           file: "gitdir: <main>/.git/worktrees/wt"
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmwt-'));
  try {
    const main = path.join(tmp, 'main');
    const wt = path.join(tmp, 'feature-wt');
    const worktreeGitDir = path.join(main, '.git', 'worktrees', 'wt');
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${worktreeGitDir}\n`);

    const cache = new Map();
    // From the worktree root.
    assert.equal(resolveProjectRoot(wt, cache), path.resolve(main));
    // From a subdirectory inside the worktree — still maps to the main root.
    assert.equal(resolveProjectRoot(path.join(wt, 'server'), cache), path.resolve(main));
    // Memoized result is reused (second call hits the cache).
    assert.equal(resolveProjectRoot(wt, cache), path.resolve(main));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveProjectRoot leaves a plain repo and its subdirs grouped by their own cwd', () => {
  // `.git` is a directory (normal checkout / main worktree): do NOT promote a
  // subdirectory to the repo root — only linked worktrees are remapped.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmplain-'));
  try {
    const repo = path.join(tmp, 'repo');
    const sub = path.join(repo, 'server');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(sub, { recursive: true });

    const cache = new Map();
    assert.equal(resolveProjectRoot(repo, cache), path.resolve(repo));
    assert.equal(resolveProjectRoot(sub, cache), path.resolve(sub));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveProjectRoot returns a non-repo directory unchanged', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmbare-'));
  try {
    assert.equal(resolveProjectRoot(tmp, new Map()), path.resolve(tmp));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function writeRollout(dir, name, rows) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n'));
  return filePath;
}

test('parseSessionMetadata attributes a resumed rollout to the thread it continues', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexmobile-parse-meta-'));
  try {
    const cwd = path.join(dir, 'repo');
    fs.mkdirSync(cwd, { recursive: true });
    const filePath = writeRollout(dir, 'rollout-resume.jsonl', [
      { timestamp: '2026-08-31T01:00:00.000Z', type: 'session_meta', payload: { id: 'own-thread', cwd, model: 'gpt-5.6' } },
      { timestamp: '2026-08-31T01:00:01.000Z', type: 'session_meta', payload: { id: 'ancestor-thread', cwd } },
      {
        timestamp: '2026-08-31T01:00:02.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '看一下这个仓库' }] }
      },
      {
        timestamp: '2026-08-31T01:00:03.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '我先读代码' }] }
      },
      {
        timestamp: '2026-08-31T01:00:04.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '结论如下' }] }
      },
      {
        timestamp: '2026-08-31T01:00:05.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>忽略我</environment_context>' }] }
      }
    ]);

    const session = await parseSessionMetadata(
      filePath,
      new Map([['ancestor-thread', { title: null, updatedAt: '2026-08-31T01:00:05.000Z' }]]),
      new Map()
    );

    // The resume file replays the ancestor's history, so it belongs to that
    // conversation — listing it under its own id duplicates the drawer row.
    assert.equal(session.id, 'ancestor-thread');
    // one visible user message + one final answer; commentary and the injected
    // environment block are not messages.
    assert.equal(session.messageCount, 2);
    assert.equal(session.title, '看一下这个仓库');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseSessionMetadata drops subagent transcripts from the session list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexmobile-parse-subagent-'));
  try {
    const filePath = writeRollout(dir, 'rollout-subagent.jsonl', [
      {
        timestamp: '2026-08-31T01:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'worker-thread', cwd: dir, thread_source: 'subagent', parent_thread_id: 'parent-thread' }
      },
      {
        timestamp: '2026-08-31T01:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '干活' }] }
      }
    ]);

    const session = await parseSessionMetadata(
      filePath,
      new Map([['worker-thread', { updatedAt: '2026-08-31T01:00:01.000Z' }]]),
      new Map()
    );

    assert.equal(session, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveProjectRoot groups removed worktrees back under their repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexmobile-dead-worktree-'));
  try {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

    // 1. worktree directory deleted after `git worktree remove`
    const gone = path.join(repo, 'worktrees', 'issue-42');
    assert.equal(resolveProjectRoot(gone, new Map()), repo);

    // 2. tooling worktree slot still on disk but no longer a git worktree
    const leftover = path.join(repo, '.claude', 'worktrees', 'ask-layout');
    fs.mkdirSync(leftover, { recursive: true });
    assert.equal(resolveProjectRoot(leftover, new Map()), repo);

    // 3. same for the plain <repo>/worktrees/<name> layout
    const plainLeftover = path.join(repo, 'worktrees', 'deploy-main');
    fs.mkdirSync(plainLeftover, { recursive: true });
    assert.equal(resolveProjectRoot(plainLeftover, new Map()), repo);

    // 4. worktrees container that sits beside the repo, not inside it
    const outside = path.join(dir, 'worktrees', 'deploy-main');
    fs.mkdirSync(outside, { recursive: true });
    assert.equal(resolveProjectRoot(outside, new Map()), dir);

    // 5. a real subdirectory of the repo keeps its own grouping (unchanged)
    const src = path.join(repo, 'src');
    fs.mkdirSync(src, { recursive: true });
    assert.equal(resolveProjectRoot(src, new Map()), src);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
