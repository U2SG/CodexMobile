// Desktop IPC method-version store.
// Layered defense for desktop protocol drift:
//  1. Hardcoded DEFAULT_DESKTOP_IPC_VERSIONS as initial seed
//  2. Override via .codexmobile/state/desktop-ipc-versions.json (file wins)
//  3. recordVersion() persists learned versions back to that file (used by auto-bump)

import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_DESKTOP_IPC_VERSIONS = Object.freeze({
  'thread-archived': 2,
  'thread-unarchived': 1,
  'thread-follower-start-turn': 1,
  'thread-follower-compact-thread': 1,
  'thread-follower-steer-turn': 1,
  'thread-follower-interrupt-turn': 1,
  'thread-follower-set-model-and-reasoning': 1,
  'thread-follower-set-collaboration-mode': 1,
  'thread-follower-edit-last-user-turn': 1,
  'thread-follower-command-approval-decision': 1,
  'thread-follower-file-approval-decision': 1,
  'thread-follower-permissions-request-approval-response': 1,
  'thread-follower-submit-user-input': 1,
  'thread-follower-submit-mcp-server-elicitation-response': 1,
  'thread-follower-set-queued-follow-ups-state': 1
});

const STATE_SUBPATH = path.join('.codexmobile', 'state', 'desktop-ipc-versions.json');

export function createIpcVersionStore({ stateDir = process.cwd(), defaults = DEFAULT_DESKTOP_IPC_VERSIONS } = {}) {
  const filePath = path.join(stateDir, STATE_SUBPATH);
  const baseDefaults = { ...defaults };
  let overrides = {};
  let initialized = false;
  let initPromise = null;

  function mergedSnapshot() {
    return { ...baseDefaults, ...overrides };
  }

  async function readFromDisk() {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.methods === 'object' && parsed.methods !== null) {
        const next = {};
        for (const [method, value] of Object.entries(parsed.methods)) {
          const num = Number(value);
          if (Number.isFinite(num) && num > 0) next[method] = num;
        }
        return next;
      }
      return {};
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      console.warn(`[ipc-versions] ignoring corrupt ${filePath}: ${error.message}`);
      return {};
    }
  }

  async function writeToDisk() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const payload = JSON.stringify({ version: 1, methods: overrides }, null, 2);
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, filePath);
  }

  async function init() {
    if (initialized) return;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      overrides = await readFromDisk();
      initialized = true;
    })();
    await initPromise;
  }

  function getVersion(method) {
    if (!method) return 0;
    if (overrides[method] !== undefined) return overrides[method];
    return baseDefaults[method] ?? 0;
  }

  async function recordVersion(method, version) {
    if (!method || !Number.isFinite(version) || version <= 0) return false;
    if (!initialized) await init();
    if (overrides[method] === version) return false;
    overrides = { ...overrides, [method]: version };
    await writeToDisk();
    return true;
  }

  async function reload() {
    overrides = await readFromDisk();
    initialized = true;
  }

  function getAll() {
    return mergedSnapshot();
  }

  return { init, getVersion, recordVersion, reload, getAll };
}
