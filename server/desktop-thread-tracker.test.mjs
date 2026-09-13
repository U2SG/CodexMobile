import { strict as assert } from 'node:assert';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { encodeFrame, decodeFrames } from './desktop-ipc-client.js';
import { createDesktopThreadTracker } from './desktop-thread-tracker.js';

let activeServer = null;
afterEach(async () => {
  if (activeServer) {
    await new Promise((resolve) => activeServer.close(resolve));
    activeServer = null;
  }
});

function makeIpcServer({ onConnect, onMessage }) {
  const sockPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\codexmobile-tracker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    : path.join(os.tmpdir(), `codexmobile-tracker-${Date.now()}.sock`);
  const server = net.createServer((socket) => {
    if (onConnect) onConnect(socket);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { messages, remainder } = decodeFrames(buffer);
      buffer = remainder;
      for (const message of messages) {
        const reply = onMessage?.(message, socket);
        if (reply) socket.write(encodeFrame(reply));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => resolve({ server, sockPath }));
  });
}

function initResponseFor(msg, clientId = 'tracker') {
  return { type: 'response', requestId: msg.requestId, method: 'initialize', resultType: 'success', result: { clientId } };
}

test('tracker accumulates conversationIds from broadcasts', async () => {
  const { server, sockPath } = await makeIpcServer({
    onConnect: (sock) => {
      setTimeout(() => {
        sock.write(encodeFrame({ type: 'broadcast', method: 'thread-stream-state-changed', params: { conversationId: 'c-1', change: { type: 'snapshot' } } }));
        sock.write(encodeFrame({ type: 'broadcast', method: 'thread-stream-state-changed', params: { conversationId: 'c-2', change: { type: 'snapshot' } } }));
      }, 20);
    },
    onMessage: (msg) => msg.method === 'initialize' ? initResponseFor(msg) : null
  });
  activeServer = server;
  const tracker = createDesktopThreadTracker({ socketPath: sockPath, reconnectMs: 50 });
  try {
    await tracker.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual([...tracker.getOpenThreadIds()].sort(), ['c-1', 'c-2']);
    assert.equal(tracker.isThreadOpen('c-1'), true);
    assert.equal(tracker.isThreadOpen('c-x'), false);
  } finally {
    await tracker.stop();
  }
});

test('tracker fires onChange when set updates', async () => {
  const events = [];
  const { server, sockPath } = await makeIpcServer({
    onConnect: (sock) => {
      setTimeout(() => {
        sock.write(encodeFrame({ type: 'broadcast', method: 'thread-stream-state-changed', params: { conversationId: 'c-a', change: { type: 'snapshot' } } }));
      }, 20);
    },
    onMessage: (msg) => msg.method === 'initialize' ? initResponseFor(msg) : null
  });
  activeServer = server;
  const tracker = createDesktopThreadTracker({ socketPath: sockPath, reconnectMs: 50 });
  tracker.onChange((set) => events.push(new Set(set)));
  try {
    await tracker.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(events.length >= 1);
    assert.ok(events.at(-1).has('c-a'));
  } finally {
    await tracker.stop();
  }
});

test('tracker reconnects after socket drop and rebuilds set', async () => {
  let connectCount = 0;
  const { server, sockPath } = await makeIpcServer({
    onConnect: (sock) => {
      connectCount += 1;
      const id = `gen-${connectCount}`;
      setTimeout(() => {
        sock.write(encodeFrame({ type: 'broadcast', method: 'thread-stream-state-changed', params: { conversationId: id, change: { type: 'snapshot' } } }));
        if (connectCount === 1) {
          // Drop the first connection after sending one snapshot.
          setTimeout(() => sock.destroy(), 30);
        }
      }, 10);
    },
    onMessage: (msg) => msg.method === 'initialize' ? initResponseFor(msg) : null
  });
  activeServer = server;
  const tracker = createDesktopThreadTracker({ socketPath: sockPath, reconnectMs: 30 });
  try {
    await tracker.start();
    // First connection sees gen-1, then dies.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(tracker.getOpenThreadIds().includes('gen-1'));
    // After reconnect, set is rebuilt; should now contain gen-2 (and not gen-1).
    await new Promise((resolve) => setTimeout(resolve, 200));
    const ids = tracker.getOpenThreadIds();
    assert.ok(ids.includes('gen-2'), `expected gen-2, got ${ids.join(',')}`);
    assert.equal(ids.includes('gen-1'), false);
    assert.ok(connectCount >= 2);
  } finally {
    await tracker.stop();
  }
});

test('tracker stop() prevents any later connected state', async () => {
  const events = [];
  const { server, sockPath } = await makeIpcServer({
    onConnect: (sock) => {
      setTimeout(() => sock.destroy(), 10);
    },
    onMessage: (msg) => msg.method === 'initialize' ? initResponseFor(msg) : null
  });
  activeServer = server;
  const tracker = createDesktopThreadTracker({ socketPath: sockPath, reconnectMs: 30 });
  tracker.onConnectionChange((state) => events.push(state.connected));
  await tracker.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await tracker.stop();
  const connectedCountAtStop = events.filter(Boolean).length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(events.filter(Boolean).length, connectedCountAtStop, 'should not publish connected after stop');
});

test('tracker stop() cancels an in-flight initialize before admission', async () => {
  const events = [];
  const { server, sockPath } = await makeIpcServer({
    onMessage: (msg, sock) => {
      if (msg.method !== 'initialize') return null;
      setTimeout(() => {
        if (!sock.destroyed) sock.write(encodeFrame(initResponseFor(msg)));
      }, 120);
      return null;
    }
  });
  activeServer = server;
  const tracker = createDesktopThreadTracker({ socketPath: sockPath, reconnectMs: 30 });
  tracker.onConnectionChange((state) => events.push(state.connected));
  const startPromise = tracker.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await tracker.stop();
  await startPromise;
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(events.includes(true), false, 'in-flight connection must never publish connected after stop');
});

test('tracker handles bad socket path with backoff retry', async () => {
  const tracker = createDesktopThreadTracker({
    socketPath: path.join(os.tmpdir(), `nonexistent-${Date.now()}.sock`),
    reconnectMs: 30,
    maxReconnectMs: 60
  });
  try {
    await tracker.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Should still have empty set, no thrown errors.
    assert.deepEqual(tracker.getOpenThreadIds(), []);
  } finally {
    await tracker.stop();
  }
});

test('tracker ignores broadcasts without conversationId', async () => {
  const { server, sockPath } = await makeIpcServer({
    onConnect: (sock) => {
      setTimeout(() => {
        sock.write(encodeFrame({ type: 'broadcast', method: 'thread-stream-state-changed', params: { hostId: 'local' } }));
        sock.write(encodeFrame({ type: 'broadcast', method: 'thread-stream-state-changed', params: { conversationId: 'c-real', change: { type: 'snapshot' } } }));
      }, 20);
    },
    onMessage: (msg) => msg.method === 'initialize' ? initResponseFor(msg) : null
  });
  activeServer = server;
  const tracker = createDesktopThreadTracker({ socketPath: sockPath, reconnectMs: 50 });
  try {
    await tracker.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual([...tracker.getOpenThreadIds()], ['c-real']);
  } finally {
    await tracker.stop();
  }
});

test('onConnectionChange fires on connect even with no open threads', async () => {
  // Server accepts initialize but never sends any thread broadcasts.
  // onChange would stay silent forever; onConnectionChange must still fire.
  const { server, sockPath } = await makeIpcServer({
    onMessage: (msg) => msg.method === 'initialize' ? initResponseFor(msg) : null
  });
  activeServer = server;
  const tracker = createDesktopThreadTracker({ socketPath: sockPath, reconnectMs: 50 });
  const events = [];
  tracker.onConnectionChange((state) => events.push(state.connected));
  try {
    await tracker.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(events, [true], 'should emit connected=true after successful initialize');
  } finally {
    await tracker.stop();
  }
});

test('onConnectionChange fires connected→disconnected→connected across socket cycle', async () => {
  let connectCount = 0;
  const { server, sockPath } = await makeIpcServer({
    onConnect: (sock) => {
      connectCount += 1;
      if (connectCount === 1) {
        // Drop the first connection a moment after initialize.
        setTimeout(() => sock.destroy(), 30);
      }
    },
    onMessage: (msg) => msg.method === 'initialize' ? initResponseFor(msg) : null
  });
  activeServer = server;
  const tracker = createDesktopThreadTracker({ socketPath: sockPath, reconnectMs: 30 });
  const events = [];
  tracker.onConnectionChange((state) => events.push(state.connected));
  try {
    await tracker.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(events.slice(0, 3), [true, false, true]);
  } finally {
    await tracker.stop();
  }
});

test('onConnectionChange replays last known state to late subscribers', async () => {
  const { server, sockPath } = await makeIpcServer({
    onMessage: (msg) => msg.method === 'initialize' ? initResponseFor(msg) : null
  });
  activeServer = server;
  const tracker = createDesktopThreadTracker({ socketPath: sockPath, reconnectMs: 50 });
  try {
    await tracker.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const events = [];
    tracker.onConnectionChange((state) => events.push(state.connected));
    assert.deepEqual(events, [true], 'late subscriber should be replayed the current connected state');
  } finally {
    await tracker.stop();
  }
});
