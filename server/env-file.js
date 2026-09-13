// Live view over the repo-root .env file. process.env is frozen when Node
// boots (--env-file / the start scripts), so editing .env normally requires
// a restart. For the few keys that are safe to change on a running server
// (model list, default model, title model), read the file directly —
// mtime-cached — and fall back to process.env when the file or key is absent.
// Keys that shape the process itself (ports, HTTPS, agent mode) must NOT go
// through here; changing those still means a restart.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ENV_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

let cache = { path: null, mtimeMs: -1, values: new Map() };

export function parseEnvFile(raw) {
  const values = new Map();
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

export async function liveEnv(key, envPath = DEFAULT_ENV_PATH) {
  try {
    const stat = await fs.stat(envPath);
    if (cache.path !== envPath || stat.mtimeMs !== cache.mtimeMs) {
      cache = { path: envPath, mtimeMs: stat.mtimeMs, values: parseEnvFile(await fs.readFile(envPath, 'utf8')) };
    }
  } catch {
    cache = { path: envPath, mtimeMs: -1, values: new Map() };
  }
  return cache.values.has(key) ? cache.values.get(key) : process.env[key];
}
