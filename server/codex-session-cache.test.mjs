import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// CODEX_HOME is captured at module load, so build the fixture first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexmobile-facts-cache-'));
const cwd = path.join(home, 'repo');
const sessionsDir = path.join(home, 'sessions', '2026', '09', '01');
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });

const rolloutPath = path.join(sessionsDir, 'rollout-2026-09-01T10-00-00-thread-1.jsonl');
function writeRollout(firstUserText) {
  fs.writeFileSync(rolloutPath, [
    { timestamp: '2026-09-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'thread-1', cwd } },
    {
      timestamp: '2026-09-01T10:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: firstUserText }] }
    }
  ].map((row) => JSON.stringify(row)).join('\n'));
}
writeRollout('第一版问题');

const cacheFile = path.join(home, 'facts-cache.json');
process.env.CODEX_HOME = home;
process.env.CODEXMOBILE_SESSION_FACTS_CACHE = cacheFile;
process.env.CODEXMOBILE_AGENT = 'codex';
// The fixture has no CLI index / state DB, so bypass the unresumable filter —
// this test is about the facts cache, not about ghost-session filtering.
process.env.CODEXMOBILE_SHOW_UNRESUMABLE = '1';

const { refreshCodexCache, getSession } = await import('./codex-data.js');

test('session facts cache persists across refreshes and re-reads changed rollouts', async () => {
  await refreshCodexCache();
  assert.equal(getSession('thread-1')?.title, '第一版问题');
  assert.ok(fs.existsSync(cacheFile), 'facts cache should be persisted');
  const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(cached.version, 1);
  assert.equal(Object.keys(cached.entries).length, 1);

  // Same content, untouched file: served from cache, same answer.
  await refreshCodexCache();
  assert.equal(getSession('thread-1')?.title, '第一版问题');

  // Rewriting the rollout must invalidate the entry (mtime + size change).
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeRollout('改过之后的问题');
  await refreshCodexCache();
  assert.equal(getSession('thread-1')?.title, '改过之后的问题');
});

test('a deleted rollout drops out of the persisted cache', async () => {
  fs.rmSync(rolloutPath);
  await refreshCodexCache();
  assert.equal(getSession('thread-1') || null, null);
  const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(Object.keys(cached.entries).length, 0);
});

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
