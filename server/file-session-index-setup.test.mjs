import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createFileSessionIndexBundle } from './file-session-index-setup.js';

let tmpRoot;
let codexDir;
let claudeDir;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fsi-setup-'));
  codexDir = path.join(tmpRoot, 'codex-sessions');
  claudeDir = path.join(tmpRoot, 'claude-projects');
  await fs.mkdir(codexDir, { recursive: true });
  await fs.mkdir(claudeDir, { recursive: true });
});

afterEach(async () => {
  // Let any fire-and-forget savePersistence settle before rm — otherwise
  // a partial fs.writeFile races the rm and surfaces as ENOTEMPTY.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test('factory enforces required deps', () => {
  assert.throws(() => createFileSessionIndexBundle({}), /rootDir is required/);
  assert.throws(() => createFileSessionIndexBundle({ rootDir: '/r' }), /codexSessionsDir is required/);
  assert.throws(() => createFileSessionIndexBundle({ rootDir: '/r', codexSessionsDir: '/c' }), /claudeProjectsDir is required/);
});

test('exposes a wired fileSessionIndex + persist path under rootDir/.codexmobile/state', () => {
  const bundle = createFileSessionIndexBundle({
    rootDir: tmpRoot,
    codexSessionsDir: codexDir,
    claudeProjectsDir: claudeDir
  });
  assert.ok(bundle.fileSessionIndex);
  // Public API the wire-up consumer expects.
  for (const method of ['getSessionsForFile', 'getFilesForSession', 'aggregateActivity', 'invalidate', 'prewarm']) {
    assert.equal(typeof bundle.fileSessionIndex[method], 'function', `missing method: ${method}`);
  }
  assert.equal(bundle.persistPath, path.join(tmpRoot, '.codexmobile', 'state', 'file-session-index.json'));
});

test('build (via getFilesForSession) writes a single atomic persistence file', async () => {
  const rollout = path.join(codexDir, 'roll.jsonl');
  await fs.writeFile(rollout, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'sess-1', cwd: codexDir } }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Add File: foo.txt\n+hello\n*** End Patch'
      },
      timestamp: new Date().toISOString()
    })
  ].join('\n') + '\n');

  const bundle = createFileSessionIndexBundle({
    rootDir: tmpRoot,
    codexSessionsDir: codexDir,
    claudeProjectsDir: claudeDir
  });
  // getFilesForSession awaits ensureBuilt(); the savePersistence inside build()
  // is fire-and-forget, so give it a tick.
  await bundle.fileSessionIndex.getFilesForSession('sess-1');
  await new Promise((resolve) => setTimeout(resolve, 50));

  const stateDir = path.join(tmpRoot, '.codexmobile', 'state');
  const files = await fs.readdir(stateDir);
  assert.deepEqual(files.sort(), ['file-session-index.json']);
});

test('classifies indexed records by which root the rollout lives under', async () => {
  const codexFilePath = path.join(codexDir, 'x.txt');
  const claudeFilePath = path.join(claudeDir, 'y.txt');
  await fs.writeFile(path.join(codexDir, 'c.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'c-sess', cwd: codexDir } }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Add File: x.txt\n+hi\n*** End Patch'
      },
      timestamp: new Date().toISOString()
    })
  ].join('\n') + '\n');
  await fs.writeFile(path.join(claudeDir, 'cl.jsonl'), [
    JSON.stringify({ sessionId: 'cl-sess', cwd: claudeDir, permissionMode: 'default' }),
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: claudeFilePath } }] }
    })
  ].join('\n') + '\n');

  const bundle = createFileSessionIndexBundle({
    rootDir: tmpRoot,
    codexSessionsDir: codexDir,
    claudeProjectsDir: claudeDir
  });
  // getSessionsForFile returns a flat array tagged with the source rollout's agent.
  const codexHit = await bundle.fileSessionIndex.getSessionsForFile(codexFilePath, { limit: 5 });
  const claudeHit = await bundle.fileSessionIndex.getSessionsForFile(claudeFilePath, { limit: 5 });
  assert.equal(codexHit.length, 1, 'codex session not indexed');
  assert.equal(codexHit[0].agent, 'codex');
  assert.equal(claudeHit.length, 1, 'claude session not indexed');
  assert.equal(claudeHit[0].agent, 'claude');
});

test('respects days=1 mtime cutoff to exclude old rollouts', async () => {
  const old = path.join(codexDir, 'old.jsonl');
  await fs.writeFile(old, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'old-sess', cwd: codexDir } }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Add File: z.txt\n+stale\n*** End Patch'
      },
      timestamp: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    })
  ].join('\n') + '\n');
  const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  await fs.utimes(old, past, past);

  const bundle = createFileSessionIndexBundle({
    rootDir: tmpRoot,
    codexSessionsDir: codexDir,
    claudeProjectsDir: claudeDir,
    days: 1
  });
  const result = await bundle.fileSessionIndex.getFilesForSession('old-sess', { limit: 5 });
  assert.equal(result.files.length, 0);
});
