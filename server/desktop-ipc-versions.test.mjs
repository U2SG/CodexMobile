import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createIpcVersionStore, DEFAULT_DESKTOP_IPC_VERSIONS } from './desktop-ipc-versions.js';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ipc-versions-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('DEFAULT_DESKTOP_IPC_VERSIONS contains the seed methods', () => {
  assert.equal(DEFAULT_DESKTOP_IPC_VERSIONS['thread-archived'], 2);
  assert.equal(DEFAULT_DESKTOP_IPC_VERSIONS['thread-follower-start-turn'], 1);
});

test('store returns defaults when no JSON file present', async () => {
  const store = createIpcVersionStore({ stateDir: tmpDir });
  await store.init();
  assert.equal(store.getVersion('thread-archived'), 2);
  assert.equal(store.getVersion('thread-follower-start-turn'), 1);
  assert.equal(store.getVersion('unknown-method'), 0);
});

test('store returns defaults including methods missing from override file', async () => {
  await fs.mkdir(path.join(tmpDir, '.codexmobile', 'state'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, '.codexmobile', 'state', 'desktop-ipc-versions.json'),
    JSON.stringify({ version: 1, methods: { 'thread-archived': 9 } })
  );
  const store = createIpcVersionStore({ stateDir: tmpDir });
  await store.init();
  assert.equal(store.getVersion('thread-archived'), 9);
  assert.equal(store.getVersion('thread-follower-start-turn'), 1);
});

test('store ignores corrupt JSON, logs warning, falls back to defaults', async () => {
  await fs.mkdir(path.join(tmpDir, '.codexmobile', 'state'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, '.codexmobile', 'state', 'desktop-ipc-versions.json'),
    'not a json'
  );
  const store = createIpcVersionStore({ stateDir: tmpDir });
  await store.init();
  assert.equal(store.getVersion('thread-archived'), 2);
});

test('recordVersion persists to JSON file and updates in-memory', async () => {
  const store = createIpcVersionStore({ stateDir: tmpDir });
  await store.init();
  await store.recordVersion('thread-archived', 7);
  assert.equal(store.getVersion('thread-archived'), 7);

  const reloaded = createIpcVersionStore({ stateDir: tmpDir });
  await reloaded.init();
  assert.equal(reloaded.getVersion('thread-archived'), 7);
});

test('recordVersion does not write when value unchanged', async () => {
  const store = createIpcVersionStore({ stateDir: tmpDir });
  await store.init();
  const filePath = path.join(tmpDir, '.codexmobile', 'state', 'desktop-ipc-versions.json');
  // First record creates the file.
  await store.recordVersion('thread-archived', 5);
  const stat1 = await fs.stat(filePath);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Re-recording the same version is a no-op.
  await store.recordVersion('thread-archived', 5);
  const stat2 = await fs.stat(filePath);
  assert.equal(stat1.mtimeMs, stat2.mtimeMs);
});

test('recordVersion preserves other methods on partial update', async () => {
  const store = createIpcVersionStore({ stateDir: tmpDir });
  await store.init();
  await store.recordVersion('thread-archived', 5);
  await store.recordVersion('thread-follower-start-turn', 3);
  const reloaded = createIpcVersionStore({ stateDir: tmpDir });
  await reloaded.init();
  assert.equal(reloaded.getVersion('thread-archived'), 5);
  assert.equal(reloaded.getVersion('thread-follower-start-turn'), 3);
});

test('reload picks up out-of-band edits to JSON file', async () => {
  const store = createIpcVersionStore({ stateDir: tmpDir });
  await store.init();
  assert.equal(store.getVersion('thread-archived'), 2);

  const filePath = path.join(tmpDir, '.codexmobile', 'state', 'desktop-ipc-versions.json');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ version: 1, methods: { 'thread-archived': 99 } }));

  await store.reload();
  assert.equal(store.getVersion('thread-archived'), 99);
});

test('getAll returns merged snapshot (defaults + overrides)', async () => {
  const store = createIpcVersionStore({ stateDir: tmpDir });
  await store.init();
  await store.recordVersion('thread-archived', 4);
  const snap = store.getAll();
  assert.equal(snap['thread-archived'], 4);
  assert.equal(snap['thread-follower-start-turn'], 1);
  // Should not contain "unknown-method".
  assert.equal(snap['unknown-method'], undefined);
});

test('accepts custom defaults map', async () => {
  const store = createIpcVersionStore({
    stateDir: tmpDir,
    defaults: { 'custom-method': 5 }
  });
  await store.init();
  assert.equal(store.getVersion('custom-method'), 5);
  assert.equal(store.getVersion('thread-archived'), 0);
});

test('init is idempotent and safe to call multiple times', async () => {
  const store = createIpcVersionStore({ stateDir: tmpDir });
  await store.init();
  await store.init();
  assert.equal(store.getVersion('thread-archived'), 2);
});

test('getVersion before init returns default but logs warning', () => {
  const store = createIpcVersionStore({ stateDir: tmpDir });
  // Calling without await init() should still work via lazy fallback to defaults.
  assert.equal(store.getVersion('thread-archived'), 2);
});

test('atomically writes via temp file (no partial reads)', async () => {
  // Smoke: just verify no .tmp file is left behind after recordVersion.
  const store = createIpcVersionStore({ stateDir: tmpDir });
  await store.init();
  await store.recordVersion('thread-archived', 8);
  const dir = path.join(tmpDir, '.codexmobile', 'state');
  const files = await fs.readdir(dir);
  assert.deepEqual(files.sort(), ['desktop-ipc-versions.json']);
});
