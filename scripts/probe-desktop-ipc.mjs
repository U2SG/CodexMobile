#!/usr/bin/env node
// Probes Codex Desktop IPC for each known method, learning which `version`
// the running desktop accepts. Persists results to .codexmobile/state/desktop-ipc-versions.json.
//
// Usage:
//   npm run ipc:probe
//   npm run ipc:probe -- --max-bumps=5
//
// The script DOES NOT pass real conversationIds, so for most methods you'll see
// "no-client-found" or similar non-version errors — those are SUCCESS signals,
// because they mean the desktop accepted the request schema at that version.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DesktopIpcClient,
  desktopIpcSocketPath,
  getDesktopIpcSocketStatus
} from '../server/desktop-ipc-client.js';
import {
  DEFAULT_DESKTOP_IPC_VERSIONS,
  createIpcVersionStore
} from '../server/desktop-ipc-versions.js';

const args = process.argv.slice(2);
function argOf(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

const MAX_BUMPS = Number(argOf('max-bumps', 5));
const TIMEOUT_MS = Number(argOf('timeout-ms', 4000));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function fmt(label, value) {
  return `${label.padEnd(58, ' ')} ${value}`;
}

async function main() {
  const sockPath = desktopIpcSocketPath();
  const status = getDesktopIpcSocketStatus(sockPath);
  if (!status.ok) {
    console.error(`✖ desktop IPC unavailable: ${status.reason}`);
    console.error('  Make sure Codex Desktop is running, then retry.');
    process.exitCode = 2;
    return;
  }
  console.log(`✓ desktop IPC socket: ${sockPath}`);

  const store = createIpcVersionStore({ stateDir: ROOT_DIR });
  await store.init();

  const methods = Object.keys(DEFAULT_DESKTOP_IPC_VERSIONS);
  console.log(`Probing ${methods.length} methods (max-bumps=${MAX_BUMPS}, timeout=${TIMEOUT_MS}ms)...\n`);

  const results = [];
  let learned = 0;
  let unchanged = 0;
  let failed = 0;

  for (const method of methods) {
    const startVersion = store.getVersion(method) || 1;
    let workingVersion = null;
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_BUMPS; attempt += 1) {
      const version = startVersion + attempt;
      const client = new DesktopIpcClient({ socketPath: sockPath, versionStore: null, maxAutoBumps: 0 });
      try {
        await client.connect({ timeoutMs: TIMEOUT_MS });
        const response = await client.request(method, {}, { timeoutMs: TIMEOUT_MS, version });
        if (response.resultType !== 'error') {
          workingVersion = version;
          break;
        }
        const err = String(response.error || '');
        lastError = err;
        if (!/version|unsupported method|unknown method/i.test(err)) {
          // Non-version error → this version is structurally accepted.
          workingVersion = version;
          break;
        }
      } catch (error) {
        lastError = error.message || String(error);
        break;
      } finally {
        client.close();
      }
    }

    if (workingVersion) {
      const before = store.getVersion(method);
      const recorded = await store.recordVersion(method, workingVersion);
      if (recorded) {
        console.log(fmt(`✓ ${method}`, `v${before} → v${workingVersion} (saved)`));
        learned += 1;
      } else {
        console.log(fmt(`= ${method}`, `v${workingVersion}`));
        unchanged += 1;
      }
      results.push({ method, version: workingVersion, status: 'ok' });
    } else {
      console.log(fmt(`✖ ${method}`, `no working version found in [${startVersion}..${startVersion + MAX_BUMPS}] — last: ${lastError}`));
      failed += 1;
      results.push({ method, version: null, status: 'failed', error: lastError });
    }
  }

  console.log('');
  console.log(`Summary: ${learned} learned, ${unchanged} unchanged, ${failed} failed of ${methods.length}.`);
  console.log(`State file: ${path.join(ROOT_DIR, '.codexmobile', 'state', 'desktop-ipc-versions.json')}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('probe failed:', error?.stack || error?.message || error);
  process.exitCode = 3;
});
