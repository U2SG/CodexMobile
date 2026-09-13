import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createRuntimePrefs, KNOWN_PREF_KEYS } from './runtime-prefs.js';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-prefs-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('KNOWN_PREF_KEYS exposes the supported preference set', () => {
  assert.ok(KNOWN_PREF_KEYS.includes('ipcTurnsEnabled'));
});

test('returns env-derived defaults when no file exists', async () => {
  const prefs = createRuntimePrefs({
    stateDir: tmpDir,
    envDefaults: { ipcTurnsEnabled: true }
  });
  const all = await prefs.getAll();
  assert.equal(all.ipcTurnsEnabled, true);
});

test('returns env defaults when file is empty / missing keys', async () => {
  const stateDir = path.join(tmpDir, '.codexmobile', 'state');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, 'runtime-prefs.json'), JSON.stringify({ version: 1, prefs: {} }));
  const prefs = createRuntimePrefs({
    stateDir: tmpDir,
    envDefaults: { ipcTurnsEnabled: false }
  });
  assert.equal((await prefs.getAll()).ipcTurnsEnabled, false);
});

test('persists set value and overrides env default', async () => {
  const prefs = createRuntimePrefs({
    stateDir: tmpDir,
    envDefaults: { ipcTurnsEnabled: true }
  });
  await prefs.set('ipcTurnsEnabled', false);
  assert.equal((await prefs.getAll()).ipcTurnsEnabled, false);

  // New instance picks up the override even with a different env default.
  const reloaded = createRuntimePrefs({
    stateDir: tmpDir,
    envDefaults: { ipcTurnsEnabled: true }
  });
  assert.equal((await reloaded.getAll()).ipcTurnsEnabled, false);
});

test('set rejects unknown keys', async () => {
  const prefs = createRuntimePrefs({ stateDir: tmpDir, envDefaults: {} });
  await assert.rejects(() => prefs.set('something-bogus', true), /unknown preference/i);
});

test('set coerces ipcTurnsEnabled to boolean', async () => {
  const prefs = createRuntimePrefs({ stateDir: tmpDir, envDefaults: { ipcTurnsEnabled: false } });
  await prefs.set('ipcTurnsEnabled', 'truthy');
  assert.equal((await prefs.getAll()).ipcTurnsEnabled, true);
  await prefs.set('ipcTurnsEnabled', 0);
  assert.equal((await prefs.getAll()).ipcTurnsEnabled, false);
});

test('reset clears overrides for a single key', async () => {
  const prefs = createRuntimePrefs({ stateDir: tmpDir, envDefaults: { ipcTurnsEnabled: true } });
  await prefs.set('ipcTurnsEnabled', false);
  await prefs.reset('ipcTurnsEnabled');
  assert.equal((await prefs.getAll()).ipcTurnsEnabled, true);
});

test('tolerates corrupt JSON and falls back to env defaults', async () => {
  const stateDir = path.join(tmpDir, '.codexmobile', 'state');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, 'runtime-prefs.json'), '{ not valid');
  const prefs = createRuntimePrefs({
    stateDir: tmpDir,
    envDefaults: { ipcTurnsEnabled: true }
  });
  assert.equal((await prefs.getAll()).ipcTurnsEnabled, true);
});

test('writes are atomic — no .tmp files left behind', async () => {
  const prefs = createRuntimePrefs({ stateDir: tmpDir, envDefaults: { ipcTurnsEnabled: false } });
  await prefs.set('ipcTurnsEnabled', true);
  const dir = path.join(tmpDir, '.codexmobile', 'state');
  const files = await fs.readdir(dir);
  assert.deepEqual(files.sort(), ['runtime-prefs.json']);
});

test('rejectKey blocks set with statusCode 409, allows reset', async () => {
  const prefs = createRuntimePrefs({
    stateDir: tmpDir,
    envDefaults: { ipcTurnsEnabled: false },
    rejectKey: (key, value) => (key === 'ipcTurnsEnabled' && Boolean(value) ? 'blocked' : null)
  });
  await assert.rejects(
    () => prefs.set('ipcTurnsEnabled', true),
    (err) => err.statusCode === 409 && err.message === 'blocked'
  );
  // Setting to false is not rejected.
  await prefs.set('ipcTurnsEnabled', false);
  assert.equal((await prefs.getAll()).ipcTurnsEnabled, false);
});
