// End-to-end probe for the desktop IPC reconnect path.
//
// Spin up a stand-in IPC server on a unique socket path, attach a real
// DesktopThreadTracker, kill the server, then start a fresh server on the
// same path. Measure how long the tracker takes to notice the disconnect
// and re-establish a working connection. The "fresh server" mimics
// restarting the Codex desktop app — same path, new listener, prior socket
// gone.
//
// Local-only by design: pointing this at the real Tailscale instance would
// mean killing the user's actual Codex desktop. The reconnect logic itself
// (server/desktop-thread-tracker.js) is the same code path used in
// production.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { encodeFrame, decodeFrames } from '../server/desktop-ipc-client.js';
import { createDesktopThreadTracker } from '../server/desktop-thread-tracker.js';

const SLO_MS = 5000;

function makeSockPath() {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\codexmobile-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return path.join(os.tmpdir(), `codexmobile-probe-${Date.now()}.sock`);
}

function startFakeServer(sockPath, generationId) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { messages, remainder } = decodeFrames(buffer);
      buffer = remainder;
      for (const msg of messages) {
        if (msg.method === 'initialize') {
          socket.write(encodeFrame({
            type: 'response',
            requestId: msg.requestId,
            method: 'initialize',
            resultType: 'success',
            result: { clientId: `${generationId}-client` }
          }));
          setTimeout(() => {
            try {
              socket.write(encodeFrame({
                type: 'broadcast',
                method: 'thread-stream-state-changed',
                params: { conversationId: generationId, change: { type: 'snapshot' } }
              }));
            } catch { /* socket closed mid-flight */ }
          }, 10);
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => resolve({ server, sockets }));
  });
}

function closeServer(handle) {
  if (!handle) return Promise.resolve();
  // server.close() only fires its callback after all open connections have
  // closed. Force-destroy any live sockets first so we don't wedge the
  // probe waiting for the (still-connected) tracker to drop us.
  for (const sock of handle.sockets) {
    try { sock.destroy(); } catch { /* noop */ }
  }
  return new Promise((resolve) => handle.server.close(() => resolve()));
}

async function waitUntil(predicate, { timeoutMs, pollMs = 20 } = {}) {
  const started = performance.now();
  for (;;) {
    if (predicate()) return performance.now() - started;
    if (performance.now() - started > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function probe({ reconnectMs }) {
  const sockPath = makeSockPath();
  let serverGen1 = await startFakeServer(sockPath, 'gen1');

  const tracker = createDesktopThreadTracker({ socketPath: sockPath, reconnectMs });
  let lastIds = new Set();
  tracker.onChange((ids) => { lastIds = new Set(ids); });

  let serverGen2 = null;
  try {
    await tracker.start();
    const sawGen1 = await waitUntil(() => lastIds.has('gen1'), { timeoutMs: 3000 });
    if (sawGen1 === null) {
      throw new Error('tracker never saw gen1 broadcast');
    }

    // Kill the first server. Time-zero for the recovery measurement is the
    // moment the kill completes (i.e. socket is gone from the OS's POV).
    await closeServer(serverGen1);
    serverGen1 = null;
    const killAt = performance.now();

    // Tiny gap so the tracker observes EOF before the next server claims
    // the same path. On Linux this matters because UNIX sockets can be
    // re-bound immediately.
    await new Promise((r) => setTimeout(r, 50));

    serverGen2 = await startFakeServer(sockPath, 'gen2');
    lastIds = new Set();
    const sawGen2 = await waitUntil(() => lastIds.has('gen2'), { timeoutMs: SLO_MS + 5000 });
    const recoveryMs = sawGen2 !== null ? Math.round(performance.now() - killAt) : null;

    return {
      reconnectMs,
      recoveryMs,
      met: recoveryMs !== null && recoveryMs < SLO_MS,
      sloMs: SLO_MS
    };
  } finally {
    await tracker.stop();
    if (serverGen1) await closeServer(serverGen1);
    if (serverGen2) await closeServer(serverGen2);
  }
}

async function run() {
  const configs = [3000, 1500];
  console.log(`SLO: kill → reconnected < ${SLO_MS}ms`);
  console.log('');
  for (const reconnectMs of configs) {
    console.log(`reconnectMs=${reconnectMs}  starting…`);
    const result = await probe({ reconnectMs });
    const status = result.met ? 'OK' : 'MISS';
    console.log(
      `reconnectMs=${reconnectMs}  recovery=${result.recoveryMs ?? 'timeout'}ms  ${status} (SLO ${result.sloMs}ms)`
    );
  }
}

run().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
