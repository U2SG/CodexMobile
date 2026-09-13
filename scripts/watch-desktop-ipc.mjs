#!/usr/bin/env node
// Listens on the Codex Desktop IPC pipe and prints every non-response frame
// it receives. Used to discover whether desktop streams thread events via
// IPC notifications, and what the event payload format looks like.
//
// Usage:
//   npm run ipc:watch                    # listen for 60s
//   npm run ipc:watch -- --duration=300  # listen for 5 minutes
//
// While this is running, manually trigger activity in Codex Desktop
// (start a turn, type a message, click an approval button) and observe
// what arrives on stdout.

import fs from 'node:fs';
import path from 'node:path';
import {
  DesktopIpcClient,
  desktopIpcSocketPath,
  getDesktopIpcSocketStatus
} from '../server/desktop-ipc-client.js';

function argOf(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

const DURATION_MS = Number(argOf('duration', 60)) * 1000;
const PRETTY = process.stdout.isTTY;

function ts() {
  const d = new Date();
  return d.toISOString().slice(11, 23);
}

async function main() {
  const sockPath = desktopIpcSocketPath();
  const status = getDesktopIpcSocketStatus(sockPath);
  if (!status.ok) {
    console.error(`✖ desktop IPC unavailable: ${status.reason}`);
    process.exitCode = 2;
    return;
  }
  console.log(`✓ listening on ${sockPath} for ${DURATION_MS / 1000}s. Trigger activity in Codex Desktop to see events stream.`);
  console.log('---');

  const rawDumpPath = path.resolve('.codexmobile', `ipc-watch-${Date.now()}.jsonl`);
  fs.mkdirSync(path.dirname(rawDumpPath), { recursive: true });
  const dumpStream = fs.createWriteStream(rawDumpPath, { flags: 'a' });
  console.log(`(raw dump → ${rawDumpPath})`);

  const client = new DesktopIpcClient({ socketPath: sockPath });
  const originalHandle = client.handleMessage.bind(client);
  let frameCount = 0;
  const seenTypes = new Map();
  client.handleMessage = (message) => {
    frameCount += 1;
    const kind = message.type || 'unknown';
    seenTypes.set(kind, (seenTypes.get(kind) || 0) + 1);
    if (message.type !== 'response') {
      // Persist FULL frame to disk for post-hoc analysis (no truncation).
      try { dumpStream.write(JSON.stringify({ ts: Date.now(), message }) + '\n'); } catch {}
      const summary = message.method ? `method=${message.method}` : '';
      const params = message.params || message.payload || message.notification || message.event || message.data;
      console.log(`[${ts()}] ${kind} ${summary}`);
      if (params) {
        const trimmed = JSON.stringify(params, null, PRETTY ? 2 : 0);
        const preview = trimmed.length > 800 ? `${trimmed.slice(0, 800)}…(${trimmed.length}b — full in dump file)` : trimmed;
        console.log(preview);
      }
      console.log('');
    }
    return originalHandle(message);
  };

  try {
    await client.connect({ timeoutMs: 4000 });
  } catch (error) {
    console.error(`✖ connect failed: ${error.message}`);
    process.exitCode = 3;
    return;
  }
  console.log(`(connected as clientId=${client.clientId})\n`);

  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));

  client.close();
  dumpStream.end();
  console.log('\n--- summary ---');
  console.log(`frames seen: ${frameCount}`);
  for (const [kind, count] of seenTypes.entries()) {
    console.log(`  ${kind}: ${count}`);
  }
  console.log(`Full dump: ${rawDumpPath}`);
}

main().catch((error) => {
  console.error('watch failed:', error?.stack || error?.message || error);
  process.exitCode = 1;
});
