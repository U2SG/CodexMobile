import assert from 'node:assert/strict';
import test from 'node:test';

import { runCodexTurnViaAppServer } from './codex-app-server-runner.js';
import { abortCodexTurn, getActiveRunRegistry } from './codex-runner.js';

function fakeClientFactory({ clientTurnId, abortAt, runtimeThreadId = 'runtime-thread', runtimeTurnId = 'runtime-turn', calls }) {
  return () => ({
    async initialize() {
      calls.push({ method: 'initialize' });
      if (abortAt === 'initialize') {
        assert.equal(abortCodexTurn(clientTurnId), true);
      }
    },
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/resume') {
        return { thread: { id: params.threadId } };
      }
      if (method === 'thread/start') {
        return { thread: { id: runtimeThreadId } };
      }
      if (method === 'turn/start') {
        if (abortAt === 'during-turn-start') {
          assert.equal(abortCodexTurn(clientTurnId), true);
        } else if (abortAt === 'after-turn-start') {
          setImmediate(() => assert.equal(abortCodexTurn(clientTurnId), true));
        }
        return { turn: { id: runtimeTurnId } };
      }
      if (method === 'turn/interrupt') {
        return {};
      }
      throw new Error(`Unexpected fake request: ${method}`);
    },
    close() {
      calls.push({ method: 'close' });
    }
  });
}

async function runCancelledTurn({ sessionId = 'existing-thread', clientTurnId, abortAt, runtimeThreadId, runtimeTurnId }) {
  const calls = [];
  const events = [];
  const result = await runCodexTurnViaAppServer({
    sessionId,
    projectPath: process.cwd(),
    message: 'isolated cancellation test',
    permissionMode: 'default',
    turnId: clientTurnId
  }, (event) => events.push(event), {
    createClient: fakeClientFactory({
      clientTurnId,
      abortAt,
      runtimeThreadId,
      runtimeTurnId,
      calls
    })
  });
  return { calls, events, result };
}

test('interrupts an admitted resumed-thread turn with the app-server runtime turn id', async () => {
  const { calls, events, result } = await runCancelledTurn({
    clientTurnId: 'client-after-response',
    abortAt: 'after-turn-start',
    runtimeTurnId: 'runtime-after-response'
  });

  const interrupt = calls.find((call) => call.method === 'turn/interrupt');
  assert.deepEqual(interrupt?.params, {
    threadId: 'existing-thread',
    turnId: 'runtime-after-response'
  });
  assert.notEqual(interrupt?.params.turnId, 'client-after-response');
  assert.equal(result, 'existing-thread');
  assert.equal(events.at(-1)?.type, 'chat-aborted');
  assert.equal(events.some((event) => event.type === 'chat-complete'), false);
  assert.equal(getActiveRunRegistry().has('client-after-response'), false);
});

test('abort during turn/start waits for admission id, then interrupts that exact runtime turn', async () => {
  const { calls, events } = await runCancelledTurn({
    sessionId: null,
    clientTurnId: 'client-during-start',
    abortAt: 'during-turn-start',
    runtimeThreadId: 'new-runtime-thread',
    runtimeTurnId: 'new-runtime-turn'
  });

  const interrupt = calls.find((call) => call.method === 'turn/interrupt');
  assert.deepEqual(interrupt?.params, {
    threadId: 'new-runtime-thread',
    turnId: 'new-runtime-turn'
  });
  assert.equal(events.find((event) => event.type === 'chat-started')?.sessionId, 'new-runtime-thread');
  assert.equal(events.at(-1)?.type, 'chat-aborted');
  assert.equal(getActiveRunRegistry().has('client-during-start'), false);
});

test('abort before turn admission does not send turn/interrupt with a client-only id', async () => {
  const { calls, events } = await runCancelledTurn({
    clientTurnId: 'client-before-admission',
    abortAt: 'initialize'
  });

  assert.equal(calls.some((call) => call.method === 'thread/resume'), false);
  assert.equal(calls.some((call) => call.method === 'turn/start'), false);
  assert.equal(calls.some((call) => call.method === 'turn/interrupt'), false);
  assert.equal(events.some((event) => event.type === 'chat-started'), false);
  assert.equal(events.at(-1)?.type, 'chat-aborted');
  assert.equal(getActiveRunRegistry().has('client-before-admission'), false);
});
