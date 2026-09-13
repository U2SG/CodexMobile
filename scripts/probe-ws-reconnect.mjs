// Live smoke for the reconnect path: open a WS to the deployed Tailscale URL,
// observe handshake outcome, close once, reopen — confirming the server
// accepts repeat connections without state corruption.
//
// No auth token is required just to probe the upgrade handshake; the server
// will respond with whatever it would normally send before authenticating the
// device, which is enough to verify reachability and reconnect tolerance.

import { WebSocket } from 'ws';

const TARGETS = [
  'wss://agent-host.example:8443/ws',
  'wss://agent-host.example/ws'
];

async function probeOnce(url, label) {
  return new Promise((resolve) => {
    const started = Date.now();
    const ws = new WebSocket(url, {
      rejectUnauthorized: false,
      perMessageDeflate: false
    });
    let settled = false;
    let openMs = null;
    let firstMsgMs = null;
    let firstMsgType = null;
    let httpStatus = null;

    const finish = (reason, extra = {}) => {
      if (settled) return;
      settled = true;
      const took = Date.now() - started;
      const ok =
        reason === 'first-message' || // got server frame (authed probe)
        httpStatus === 401;            // unauthed probe → server is alive and gating correctly
      console.log(
        `[${label}] ${url}  -> ${ok ? 'OK' : 'FAIL'} (${reason}${httpStatus ? `, http=${httpStatus}` : ''}, ${took}ms)`,
        Object.keys(extra).length ? extra : ''
      );
      try { ws.terminate(); } catch { /* noop */ }
      resolve({ ok, openMs, firstMsgMs, firstMsgType, reason, httpStatus, totalMs: took });
    };

    ws.on('open', () => {
      openMs = Date.now() - started;
    });
    ws.on('message', (data) => {
      if (firstMsgMs === null) {
        firstMsgMs = Date.now() - started;
        try {
          const parsed = JSON.parse(data.toString());
          firstMsgType = parsed.type || 'unknown';
        } catch {
          firstMsgType = 'non-json';
        }
        finish('first-message');
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      httpStatus = res.statusCode;
      finish(`http-${res.statusCode}`);
    });
    ws.on('error', (err) => finish('error', { message: err.message, code: err.code }));
    ws.on('close', (code, reason) => {
      if (firstMsgMs === null) {
        finish('close-before-msg', { code, reason: reason?.toString() });
      }
    });

    setTimeout(() => {
      if (!settled) finish('timeout');
    }, 8000);
  });
}

async function run() {
  for (const url of TARGETS) {
    const r1 = await probeOnce(url, 'connect#1');
    // Simulate a quick reconnect (visibility wake → forceReconnectNow)
    await new Promise((r) => setTimeout(r, 250));
    const r2 = await probeOnce(url, 'connect#2');
    const within5s = r1.totalMs < 5000 && r2.totalMs < 5000;
    console.log(
      `  ↳ summary: ${r1.ok && r2.ok ? 'both OK' : 'INCONSISTENT'}; <5s reconnect SLO ${within5s ? 'met' : 'MISSED'}`
    );
    console.log('');
  }
}

run().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
