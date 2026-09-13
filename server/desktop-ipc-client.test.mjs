import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  DesktopIpcClient,
  decodeFrames,
  desktopIpcMethodVersion,
  desktopIpcSocketPath,
  encodeFrame,
  interruptDesktopFollowerTurn,
  probeDesktopIpc,
  startDesktopFollowerTurn,
  steerDesktopFollowerTurn
} from './desktop-ipc-client.js';
import { createIpcVersionStore } from './desktop-ipc-versions.js';

let activeServer = null;
afterEach(async () => {
  if (activeServer) {
    await new Promise((resolve) => activeServer.close(resolve));
    activeServer = null;
  }
});

test('desktopIpcSocketPath uses Windows pipe on win32', () => {
  if (process.platform !== 'win32') return;
  assert.equal(desktopIpcSocketPath(), '\\\\.\\pipe\\codex-ipc');
});

test('desktopIpcSocketPath uses Unix socket on posix', () => {
  if (process.platform === 'win32') return;
  const sockPath = desktopIpcSocketPath();
  assert.ok(sockPath.includes(os.tmpdir()));
  assert.ok(sockPath.includes('codex-ipc'));
});

test('desktopIpcMethodVersion returns version for known method, 0 for unknown', () => {
  assert.equal(desktopIpcMethodVersion('thread-archived'), 2);
  assert.equal(desktopIpcMethodVersion('thread-follower-start-turn'), 1);
  assert.equal(desktopIpcMethodVersion('totally-unknown-method'), 0);
});

test('encodeFrame produces 4-byte LE length prefix + UTF-8 JSON', () => {
  const frame = encodeFrame({ hello: '世界' });
  const len = frame.readUInt32LE(0);
  const body = frame.subarray(4);
  assert.equal(body.length, len);
  assert.deepEqual(JSON.parse(body.toString('utf8')), { hello: '世界' });
});

test('decodeFrames parses one complete frame and returns remainder', () => {
  const a = encodeFrame({ msg: 'a' });
  const b = encodeFrame({ msg: 'b' });
  const stream = Buffer.concat([a, b.subarray(0, 3)]);
  const { messages, remainder } = decodeFrames(stream);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { msg: 'a' });
  assert.equal(remainder.length, 3);
});

test('decodeFrames handles split header (less than 4 bytes)', () => {
  const a = encodeFrame({ msg: 'a' });
  const stream = a.subarray(0, 2);
  const { messages, remainder } = decodeFrames(stream);
  assert.equal(messages.length, 0);
  assert.equal(remainder.length, 2);
});

test('decodeFrames returns multiple messages when buffer holds them all', () => {
  const stream = Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 }), encodeFrame({ n: 3 })]);
  const { messages, remainder } = decodeFrames(stream);
  assert.equal(messages.length, 3);
  assert.equal(remainder.length, 0);
  assert.deepEqual(messages.map((m) => m.n), [1, 2, 3]);
});

test('decodeFrames skips a single malformed JSON frame and continues', () => {
  const garbage = Buffer.from('not json{');
  const garbageHeader = Buffer.alloc(4);
  garbageHeader.writeUInt32LE(garbage.length, 0);
  const stream = Buffer.concat([garbageHeader, garbage, encodeFrame({ n: 7 })]);
  const { messages } = decodeFrames(stream);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].n, 7);
});

function makeFakeIpcServer(handler) {
  const sockPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\codexmobile-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    : path.join(os.tmpdir(), `codexmobile-test-${Date.now()}.sock`);
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { messages, remainder } = decodeFrames(buffer);
      buffer = remainder;
      for (const message of messages) {
        const reply = handler(message);
        if (reply) socket.write(encodeFrame(reply));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => resolve({ server, sockPath }));
  });
}

test('client connects, initializes, and resolves request response', async () => {
  const { server, sockPath } = await makeFakeIpcServer((msg) => {
    if (msg.method === 'initialize') {
      return {
        type: 'response',
        requestId: msg.requestId,
        method: 'initialize',
        resultType: 'success',
        result: { clientId: 'srv-assigned-id' }
      };
    }
    if (msg.method === 'thread-follower-start-turn') {
      return {
        type: 'response',
        requestId: msg.requestId,
        method: msg.method,
        resultType: 'success',
        result: { turnId: 't-1' }
      };
    }
    return null;
  });
  activeServer = server;
  const client = new DesktopIpcClient({ socketPath: sockPath });
  try {
    await client.connect({ timeoutMs: 2000 });
    assert.equal(client.clientId, 'srv-assigned-id');
    const response = await client.request('thread-follower-start-turn', { conversationId: 'c-1' }, { timeoutMs: 2000 });
    assert.equal(response.resultType, 'success');
    assert.deepEqual(response.result, { turnId: 't-1' });
  } finally {
    client.close();
  }
});

test('client request times out when server never replies', async () => {
  const { server, sockPath } = await makeFakeIpcServer((msg) => {
    if (msg.method === 'initialize') {
      return {
        type: 'response',
        requestId: msg.requestId,
        method: 'initialize',
        resultType: 'success',
        result: { clientId: 'x' }
      };
    }
    return null;
  });
  activeServer = server;
  const client = new DesktopIpcClient({ socketPath: sockPath });
  try {
    await client.connect({ timeoutMs: 2000 });
    await assert.rejects(
      () => client.request('thread-follower-start-turn', {}, { timeoutMs: 50 }),
      (error) => error.code === 'CODEXMOBILE_DESKTOP_IPC_TIMEOUT'
    );
  } finally {
    client.close();
  }
});

test('client invokes onBroadcast for non-response messages', async () => {
  const captured = [];
  const { server, sockPath } = await makeFakeIpcServer((msg) => {
    if (msg.method === 'initialize') {
      return { type: 'response', requestId: msg.requestId, method: 'initialize', resultType: 'success', result: { clientId: 'b' } };
    }
    return null;
  });
  activeServer = server;
  server.on('connection', (socket) => {
    setTimeout(() => {
      socket.write(encodeFrame({ type: 'broadcast', method: 'thread-stream-state-changed', params: { conversationId: 'c-1', change: { type: 'snapshot' } } }));
      socket.write(encodeFrame({ type: 'broadcast', method: 'thread-archived', params: { conversationId: 'c-2' } }));
    }, 20);
  });
  const client = new DesktopIpcClient({
    socketPath: sockPath,
    onBroadcast: (msg) => captured.push(msg)
  });
  try {
    await client.connect({ timeoutMs: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(captured.length, 2);
    assert.equal(captured[0].method, 'thread-stream-state-changed');
    assert.equal(captured[0].params.conversationId, 'c-1');
    assert.equal(captured[1].method, 'thread-archived');
  } finally {
    client.close();
  }
});

test('client invokes onClose when socket closes', async () => {
  let closed = false;
  let serverSocket = null;
  const { server, sockPath } = await makeFakeIpcServer((msg) => {
    if (msg.method === 'initialize') {
      return { type: 'response', requestId: msg.requestId, method: 'initialize', resultType: 'success', result: { clientId: 'cl' } };
    }
    return null;
  });
  activeServer = server;
  server.on('connection', (sock) => { serverSocket = sock; });
  const client = new DesktopIpcClient({
    socketPath: sockPath,
    onClose: () => { closed = true; }
  });
  try {
    await client.connect({ timeoutMs: 2000 });
    // Force the underlying connection to close from the server side.
    serverSocket?.destroy();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(closed, true);
  } finally {
    client.close();
  }
});

test('client responds to client-discovery-request with canHandle:false', async () => {
  let discoveryEcho = null;
  const { server, sockPath } = await makeFakeIpcServer((msg) => {
    if (msg.method === 'initialize') {
      return {
        type: 'response',
        requestId: msg.requestId,
        method: 'initialize',
        resultType: 'success',
        result: { clientId: 'x' }
      };
    }
    if (msg.type === 'client-discovery-response') {
      discoveryEcho = msg;
    }
    return null;
  });
  activeServer = server;
  // Server proactively pushes a discovery-request after client connects.
  server.on('connection', (socket) => {
    setTimeout(() => {
      socket.write(encodeFrame({ type: 'client-discovery-request', requestId: 'disc-1' }));
    }, 20);
  });
  const client = new DesktopIpcClient({ socketPath: sockPath });
  try {
    await client.connect({ timeoutMs: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(discoveryEcho, 'server should receive a discovery-response');
    assert.equal(discoveryEcho.type, 'client-discovery-response');
    assert.equal(discoveryEcho.requestId, 'disc-1');
    assert.equal(discoveryEcho.response.canHandle, false);
  } finally {
    client.close();
  }
});

test('probeDesktopIpc returns disconnected when socket missing', async () => {
  const fakePath = path.join(os.tmpdir(), `nonexistent-${Date.now()}.sock`);
  const result = await probeDesktopIpc({ socketPath: fakePath, timeoutMs: 200 });
  assert.equal(result.connected, false);
  assert.equal(result.mode, 'desktop-ipc');
  assert.ok(result.reason);
});

test('probeDesktopIpc returns connected when initialize succeeds', async () => {
  const { server, sockPath } = await makeFakeIpcServer((msg) => {
    if (msg.method === 'initialize') {
      return {
        type: 'response',
        requestId: msg.requestId,
        method: 'initialize',
        resultType: 'success',
        result: { clientId: 'p' }
      };
    }
    return null;
  });
  activeServer = server;
  const result = await probeDesktopIpc({ socketPath: sockPath, timeoutMs: 2000 });
  assert.equal(result.connected, true);
  assert.equal(result.mode, 'desktop-ipc');
  assert.equal(result.reason, null);
});

// --- Layer 2: auto-bump on version error ---

async function makeAutoBumpServer({ acceptedVersion }) {
  return makeFakeIpcServer((msg) => {
    if (msg.method === 'initialize') {
      return {
        type: 'response',
        requestId: msg.requestId,
        method: 'initialize',
        resultType: 'success',
        result: { clientId: 'auto' }
      };
    }
    if (msg.method === 'thread-archived') {
      if (msg.version === acceptedVersion) {
        return {
          type: 'response',
          requestId: msg.requestId,
          method: msg.method,
          resultType: 'success',
          result: { archived: true, version: msg.version }
        };
      }
      return {
        type: 'response',
        requestId: msg.requestId,
        method: msg.method,
        resultType: 'error',
        error: `unsupported version ${msg.version} for ${msg.method}`
      };
    }
    return null;
  });
}

test('auto-bump retries with version+1 when desktop reports unsupported version', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ipc-bump-'));
  try {
    const { server, sockPath } = await makeAutoBumpServer({ acceptedVersion: 4 });
    activeServer = server;
    const versionStore = createIpcVersionStore({ stateDir: tmpDir });
    await versionStore.init();
    const client = new DesktopIpcClient({ socketPath: sockPath, versionStore, maxAutoBumps: 5 });
    try {
      await client.connect({ timeoutMs: 2000 });
      const response = await client.request('thread-archived', {}, { timeoutMs: 2000 });
      assert.equal(response.resultType, 'success');
      assert.equal(response.result.version, 4);
      assert.equal(versionStore.getVersion('thread-archived'), 4);
    } finally {
      client.close();
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('auto-bump persists learned version across new clients', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ipc-persist-'));
  try {
    const { server, sockPath } = await makeAutoBumpServer({ acceptedVersion: 3 });
    activeServer = server;
    const store = createIpcVersionStore({ stateDir: tmpDir });
    await store.init();
    const client1 = new DesktopIpcClient({ socketPath: sockPath, versionStore: store, maxAutoBumps: 4 });
    await client1.connect({ timeoutMs: 2000 });
    await client1.request('thread-archived', {}, { timeoutMs: 2000 });
    client1.close();

    const store2 = createIpcVersionStore({ stateDir: tmpDir });
    await store2.init();
    assert.equal(store2.getVersion('thread-archived'), 3);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('auto-bump gives up after maxAutoBumps and surfaces last error', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ipc-giveup-'));
  try {
    const { server, sockPath } = await makeAutoBumpServer({ acceptedVersion: 99 });
    activeServer = server;
    const store = createIpcVersionStore({ stateDir: tmpDir });
    await store.init();
    const client = new DesktopIpcClient({ socketPath: sockPath, versionStore: store, maxAutoBumps: 2 });
    try {
      await client.connect({ timeoutMs: 2000 });
      const response = await client.request('thread-archived', {}, { timeoutMs: 2000 });
      assert.equal(response.resultType, 'error');
      assert.match(response.error, /unsupported version/);
    } finally {
      client.close();
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('non-version errors do not trigger auto-bump', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ipc-non-version-'));
  try {
    let calls = 0;
    const { server, sockPath } = await makeFakeIpcServer((msg) => {
      if (msg.method === 'initialize') {
        return {
          type: 'response',
          requestId: msg.requestId,
          method: 'initialize',
          resultType: 'success',
          result: { clientId: 'x' }
        };
      }
      if (msg.method === 'thread-archived') {
        calls += 1;
        return {
          type: 'response',
          requestId: msg.requestId,
          method: msg.method,
          resultType: 'error',
          error: 'no-client-found'
        };
      }
      return null;
    });
    activeServer = server;
    const store = createIpcVersionStore({ stateDir: tmpDir });
    await store.init();
    const client = new DesktopIpcClient({ socketPath: sockPath, versionStore: store, maxAutoBumps: 5 });
    try {
      await client.connect({ timeoutMs: 2000 });
      const response = await client.request('thread-archived', {}, { timeoutMs: 2000 });
      assert.equal(response.resultType, 'error');
      assert.equal(calls, 1, 'should not retry on non-version errors');
    } finally {
      client.close();
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('auto-bump uses store version when no explicit version passed', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ipc-explicit-'));
  try {
    const { server, sockPath } = await makeAutoBumpServer({ acceptedVersion: 7 });
    activeServer = server;
    const store = createIpcVersionStore({ stateDir: tmpDir });
    await store.init();
    await store.recordVersion('thread-archived', 7); // pre-seed to skip the bumping
    const client = new DesktopIpcClient({ socketPath: sockPath, versionStore: store, maxAutoBumps: 5 });
    try {
      await client.connect({ timeoutMs: 2000 });
      const response = await client.request('thread-archived', {}, { timeoutMs: 2000 });
      assert.equal(response.resultType, 'success');
      assert.equal(response.result.version, 7);
    } finally {
      client.close();
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// --- Follower helpers (interrupt + steer) ---

test('interruptDesktopFollowerTurn sends thread-follower-interrupt-turn with conversationId', async () => {
  const captured = [];
  const { server, sockPath } = await makeFakeIpcServer((msg) => {
    captured.push(msg);
    if (msg.method === 'initialize') {
      return {
        type: 'response', requestId: msg.requestId, method: 'initialize',
        resultType: 'success', result: { clientId: 'h' }
      };
    }
    if (msg.method === 'thread-follower-interrupt-turn') {
      return {
        type: 'response', requestId: msg.requestId, method: msg.method,
        resultType: 'success', result: { interrupted: true }
      };
    }
    return null;
  });
  activeServer = server;
  const result = await interruptDesktopFollowerTurn('conv-42', { socketPath: sockPath, timeoutMs: 2000 });
  assert.deepEqual(result, { interrupted: true });
  const interruptMsg = captured.find((m) => m.method === 'thread-follower-interrupt-turn');
  assert.ok(interruptMsg);
  assert.equal(interruptMsg.params.conversationId, 'conv-42');
});

test('steerDesktopFollowerTurn sends thread-follower-steer-turn with input + attachments', async () => {
  const captured = [];
  const { server, sockPath } = await makeFakeIpcServer((msg) => {
    captured.push(msg);
    if (msg.method === 'initialize') {
      return { type: 'response', requestId: msg.requestId, method: 'initialize', resultType: 'success', result: { clientId: 's' } };
    }
    if (msg.method === 'thread-follower-steer-turn') {
      return { type: 'response', requestId: msg.requestId, method: msg.method, resultType: 'success', result: { steered: true } };
    }
    return null;
  });
  activeServer = server;
  const result = await steerDesktopFollowerTurn('conv-99', {
    input: '换个思路',
    attachments: [],
    restoreMessage: { id: 'restore-1' }
  }, { socketPath: sockPath, timeoutMs: 2000 });
  assert.deepEqual(result, { steered: true });
  const steerMsg = captured.find((m) => m.method === 'thread-follower-steer-turn');
  assert.equal(steerMsg.params.conversationId, 'conv-99');
  assert.equal(steerMsg.params.input, '换个思路');
  assert.deepEqual(steerMsg.params.restoreMessage, { id: 'restore-1' });
});

test('interruptDesktopFollowerTurn surfaces no-client-found as 409', async () => {
  const { server, sockPath } = await makeFakeIpcServer((msg) => {
    if (msg.method === 'initialize') {
      return { type: 'response', requestId: msg.requestId, method: 'initialize', resultType: 'success', result: { clientId: 'x' } };
    }
    if (msg.method === 'thread-follower-interrupt-turn') {
      return { type: 'response', requestId: msg.requestId, method: msg.method, resultType: 'error', error: 'no-client-found' };
    }
    return null;
  });
  activeServer = server;
  await assert.rejects(
    () => interruptDesktopFollowerTurn('missing', { socketPath: sockPath, timeoutMs: 2000 }),
    (error) => error.statusCode === 409
  );
});

test('startDesktopFollowerTurn sends thread-follower-start-turn with turnStartParams', async () => {
  const captured = [];
  const { server, sockPath } = await makeFakeIpcServer((msg) => {
    captured.push(msg);
    if (msg.method === 'initialize') {
      return { type: 'response', requestId: msg.requestId, method: 'initialize', resultType: 'success', result: { clientId: 'st' } };
    }
    if (msg.method === 'thread-follower-start-turn') {
      return {
        type: 'response',
        requestId: msg.requestId,
        method: msg.method,
        resultType: 'success',
        result: { turn: { id: 'turn-99' } }
      };
    }
    return null;
  });
  activeServer = server;
  const result = await startDesktopFollowerTurn('conv-1', {
    input: '帮我看看这个 bug',
    cwd: 'D:\\\\project',
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
    model: 'gpt-5.5',
    effort: 'medium'
  }, { socketPath: sockPath, timeoutMs: 2000 });
  assert.deepEqual(result, { turn: { id: 'turn-99' } });
  const startMsg = captured.find((m) => m.method === 'thread-follower-start-turn');
  assert.equal(startMsg.params.conversationId, 'conv-1');
  assert.equal(startMsg.params.turnStartParams.input, '帮我看看这个 bug');
  assert.equal(startMsg.params.turnStartParams.model, 'gpt-5.5');
});

test('startDesktopFollowerTurn surfaces no-client-found as 409', async () => {
  const { server, sockPath } = await makeFakeIpcServer((msg) => {
    if (msg.method === 'initialize') {
      return { type: 'response', requestId: msg.requestId, method: 'initialize', resultType: 'success', result: { clientId: 's' } };
    }
    if (msg.method === 'thread-follower-start-turn') {
      return { type: 'response', requestId: msg.requestId, method: msg.method, resultType: 'error', error: 'no-client-found' };
    }
    return null;
  });
  activeServer = server;
  await assert.rejects(
    () => startDesktopFollowerTurn('missing', { input: 'x' }, { socketPath: sockPath, timeoutMs: 2000 }),
    (error) => error.statusCode === 409
  );
});

test('steerDesktopFollowerTurn surfaces other errors as 502', async () => {
  const { server, sockPath } = await makeFakeIpcServer((msg) => {
    if (msg.method === 'initialize') {
      return { type: 'response', requestId: msg.requestId, method: 'initialize', resultType: 'success', result: { clientId: 'x' } };
    }
    if (msg.method === 'thread-follower-steer-turn') {
      return { type: 'response', requestId: msg.requestId, method: msg.method, resultType: 'error', error: 'turn-already-completed' };
    }
    return null;
  });
  activeServer = server;
  await assert.rejects(
    () => steerDesktopFollowerTurn('c', { input: 'x' }, { socketPath: sockPath, timeoutMs: 2000 }),
    (error) => error.statusCode === 502 && /turn-already-completed/.test(error.message)
  );
});

test('explicit version option overrides store and disables auto-bump', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ipc-override-'));
  try {
    const { server, sockPath } = await makeAutoBumpServer({ acceptedVersion: 5 });
    activeServer = server;
    const store = createIpcVersionStore({ stateDir: tmpDir });
    await store.init();
    const client = new DesktopIpcClient({ socketPath: sockPath, versionStore: store, maxAutoBumps: 10 });
    try {
      await client.connect({ timeoutMs: 2000 });
      const response = await client.request('thread-archived', {}, { timeoutMs: 2000, version: 1 });
      assert.equal(response.resultType, 'error');
      assert.equal(store.getVersion('thread-archived'), 2); // unchanged from default
    } finally {
      client.close();
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
