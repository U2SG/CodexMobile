// Persistent runtime preferences. Each key has an env-derived default that
// can be overridden by a value in .codexmobile/state/runtime-prefs.json,
// allowing the UI to flip behaviour without restarting the server.
//
// Adding a new preference: add it to KNOWN_PREF_KEYS, plus a coercer in
// COERCERS so we can reject malformed input from clients.

import fs from 'node:fs/promises';
import path from 'node:path';

export const KNOWN_PREF_KEYS = Object.freeze(['ipcTurnsEnabled']);

const COERCERS = {
  ipcTurnsEnabled: (value) => Boolean(value)
};

const STATE_SUBPATH = path.join('.codexmobile', 'state', 'runtime-prefs.json');

export function createRuntimePrefs({ stateDir = process.cwd(), envDefaults = {}, rejectKey = null } = {}) {
  const filePath = path.join(stateDir, STATE_SUBPATH);
  let cache = null;

  async function readOverrides() {
    if (cache) return cache;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.prefs === 'object' && parsed.prefs !== null) {
        const next = {};
        for (const key of KNOWN_PREF_KEYS) {
          if (Object.prototype.hasOwnProperty.call(parsed.prefs, key)) {
            next[key] = parsed.prefs[key];
          }
        }
        cache = next;
      } else {
        cache = {};
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[runtime-prefs] ignoring corrupt ${filePath}: ${error.message}`);
      }
      cache = {};
    }
    return cache;
  }

  async function writeOverrides(overrides) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, prefs: overrides }, null, 2), 'utf8');
    await fs.rename(tmp, filePath);
  }

  async function getAll() {
    const overrides = await readOverrides();
    const merged = {};
    for (const key of KNOWN_PREF_KEYS) {
      merged[key] = Object.prototype.hasOwnProperty.call(overrides, key)
        ? overrides[key]
        : envDefaults[key];
    }
    return merged;
  }

  async function set(key, value) {
    if (!KNOWN_PREF_KEYS.includes(key)) {
      const error = new Error(`unknown preference: ${key}`);
      error.statusCode = 400;
      throw error;
    }
    const rejectionReason = typeof rejectKey === 'function' ? rejectKey(key, value) : null;
    if (rejectionReason) {
      const error = new Error(rejectionReason);
      error.statusCode = 409;
      throw error;
    }
    const coercer = COERCERS[key];
    const coerced = coercer ? coercer(value) : value;
    const overrides = await readOverrides();
    cache = { ...overrides, [key]: coerced };
    await writeOverrides(cache);
    return coerced;
  }

  async function reset(key) {
    if (!KNOWN_PREF_KEYS.includes(key)) {
      const error = new Error(`unknown preference: ${key}`);
      error.statusCode = 400;
      throw error;
    }
    const overrides = await readOverrides();
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) return;
    const next = { ...overrides };
    delete next[key];
    cache = next;
    await writeOverrides(cache);
  }

  return { getAll, set, reset };
}
