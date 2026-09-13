import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aliasClientTurnLatency,
  beginClientTurnLatency,
  clientTurnLatencySnapshot,
  finishClientTurnLatency,
  markClientTurnLatency,
  resetClientTurnLatencies
} from './turn-latency.js';

test('client latency separates request, stream arrival, apply, and terminal milestones', () => {
  resetClientTurnLatencies();
  beginClientTurnLatency('turn-1', 10);
  markClientTurnLatency('turn-1', 'sendResponse', 40);
  markClientTurnLatency('turn-1', 'firstWsEvent', 55);
  markClientTurnLatency('turn-1', 'firstAssistantFrame', 210);
  markClientTurnLatency('turn-1', 'firstTextApplied', 270);
  const logged = [];
  const snapshot = finishClientTurnLatency('turn-1', 'completed', 1000, (...args) => logged.push(args));

  assert.deepEqual(snapshot, {
    turnId: 'turn-1',
    outcome: 'completed',
    submitToSendResponseMs: 30,
    submitToFirstWsEventMs: 45,
    submitToFirstAssistantFrameMs: 200,
    submitToFirstTextAppliedMs: 260,
    firstFrameToTextAppliedMs: 60,
    submitToTerminalMs: 990
  });
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], '[turn-latency-client]');
});

test('client milestones are first-write wins', () => {
  resetClientTurnLatencies();
  beginClientTurnLatency('turn-2', 0);
  markClientTurnLatency('turn-2', 'firstAssistantFrame', 100);
  markClientTurnLatency('turn-2', 'firstAssistantFrame', 500);
  assert.equal(clientTurnLatencySnapshot('turn-2').submitToFirstAssistantFrameMs, 100);
});

test('runtime turn ids can alias the original client turn trace', () => {
  resetClientTurnLatencies();
  beginClientTurnLatency('client-turn', 0);
  aliasClientTurnLatency('client-turn', 'runtime-turn');
  markClientTurnLatency('runtime-turn', 'firstAssistantFrame', 125);
  assert.equal(clientTurnLatencySnapshot('client-turn').submitToFirstAssistantFrameMs, 125);
});

test('terminal logging waits for committed text when an assistant frame arrived first', () => {
  resetClientTurnLatencies();
  const logged = [];
  beginClientTurnLatency('turn-deferred', 0);
  markClientTurnLatency('turn-deferred', 'firstAssistantFrame', 100);
  finishClientTurnLatency('turn-deferred', 'completed', 150, (...args) => logged.push(args));
  assert.equal(logged.length, 0);

  markClientTurnLatency('turn-deferred', 'firstTextApplied', 175);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][1].submitToFirstTextAppliedMs, 175);
  assert.equal(logged[0][1].firstFrameToTextAppliedMs, 75);
});

test('unknown turns are ignored instead of creating background telemetry', () => {
  resetClientTurnLatencies();
  assert.equal(markClientTurnLatency('background-turn', 'firstWsEvent', 10), null);
  assert.equal(finishClientTurnLatency('background-turn', 'completed', 20, () => {}), null);
});
