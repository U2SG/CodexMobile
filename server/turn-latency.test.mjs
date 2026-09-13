import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTurnLatencyTrace,
  markTurnLatency,
  observeTurnLatencyEvent,
  turnLatencyDurations
} from './turn-latency.js';

test('turn latency exposes duration-only server milestones', () => {
  const trace = createTurnLatencyTrace(1000);
  markTurnLatency(trace, 'accepted', 1120);
  markTurnLatency(trace, 'queued', 1130);
  markTurnLatency(trace, 'runnerStarted', 1500);
  observeTurnLatencyEvent(trace, { type: 'chat-started' }, 1520);
  observeTurnLatencyEvent(trace, { type: 'assistant-update', content: 'hello' }, 2800);
  observeTurnLatencyEvent(trace, { type: 'chat-complete' }, 5000);

  assert.deepEqual(turnLatencyDurations(trace), {
    requestToAcceptedMs: 120,
    acceptedToRunnerMs: 380,
    queueWaitMs: 370,
    runnerToFirstEventMs: 20,
    runnerToFirstAssistantMs: 1300,
    firstEventToFirstAssistantMs: 1280,
    totalServerMs: 4000
  });
});

test('milestones are first-write wins so repeated stream events cannot move the baseline', () => {
  const trace = createTurnLatencyTrace(0);
  markTurnLatency(trace, 'accepted', 10);
  markTurnLatency(trace, 'accepted', 99);
  markTurnLatency(trace, 'runnerStarted', 20);
  observeTurnLatencyEvent(trace, { type: 'status-update' }, 30);
  observeTurnLatencyEvent(trace, { type: 'assistant-update', content: 'first' }, 40);
  observeTurnLatencyEvent(trace, { type: 'assistant-update', content: 'second' }, 80);

  assert.equal(trace.acceptedAtMs, 10);
  assert.equal(trace.firstEventAtMs, 30);
  assert.equal(trace.firstAssistantAtMs, 40);
});

test('unknown or missing milestones stay null instead of inventing measurements', () => {
  const trace = createTurnLatencyTrace(100);
  markTurnLatency(trace, 'accepted', 130);
  assert.deepEqual(turnLatencyDurations(trace), {
    requestToAcceptedMs: 30,
    acceptedToRunnerMs: null,
    queueWaitMs: null,
    runnerToFirstEventMs: null,
    runnerToFirstAssistantMs: null,
    firstEventToFirstAssistantMs: null,
    totalServerMs: null
  });
});
