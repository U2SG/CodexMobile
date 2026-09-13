// Duration-only turn telemetry. Never add prompts, message content, attachment
// paths, credentials, or other user payloads to this trace/snapshot.
const MILESTONE_FIELDS = {
  accepted: 'acceptedAtMs',
  queued: 'queuedAtMs',
  runnerStarted: 'runnerStartedAtMs',
  firstEvent: 'firstEventAtMs',
  firstAssistant: 'firstAssistantAtMs',
  completed: 'completedAtMs'
};

function finiteMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function duration(end, start) {
  const endMs = finiteMs(end);
  const startMs = finiteMs(start);
  if (endMs === null || startMs === null || endMs < startMs) return null;
  return Math.round(endMs - startMs);
}

export function createTurnLatencyTrace(receivedAtMs = Date.now()) {
  return {
    receivedAtMs: finiteMs(receivedAtMs) ?? Date.now(),
    acceptedAtMs: null,
    queuedAtMs: null,
    runnerStartedAtMs: null,
    firstEventAtMs: null,
    firstAssistantAtMs: null,
    completedAtMs: null
  };
}

export function markTurnLatency(trace, milestone, atMs = Date.now()) {
  if (!trace || typeof trace !== 'object') return trace;
  const field = MILESTONE_FIELDS[milestone];
  const timestamp = finiteMs(atMs);
  if (!field || timestamp === null) return trace;
  if (trace[field] === null || trace[field] === undefined) {
    trace[field] = timestamp;
  }
  return trace;
}

export function turnLatencyDurations(trace) {
  if (!trace || typeof trace !== 'object') return null;
  return {
    requestToAcceptedMs: duration(trace.acceptedAtMs, trace.receivedAtMs),
    acceptedToRunnerMs: duration(trace.runnerStartedAtMs, trace.acceptedAtMs),
    queueWaitMs: trace.queuedAtMs === null || trace.queuedAtMs === undefined
      ? null
      : duration(trace.runnerStartedAtMs, trace.queuedAtMs),
    runnerToFirstEventMs: duration(trace.firstEventAtMs, trace.runnerStartedAtMs),
    runnerToFirstAssistantMs: duration(trace.firstAssistantAtMs, trace.runnerStartedAtMs),
    firstEventToFirstAssistantMs: duration(trace.firstAssistantAtMs, trace.firstEventAtMs),
    totalServerMs: duration(trace.completedAtMs, trace.receivedAtMs)
  };
}

export function isTerminalTurnEvent(payload) {
  return ['chat-complete', 'chat-error', 'chat-aborted'].includes(String(payload?.type || ''));
}

export function observeTurnLatencyEvent(trace, payload, atMs = Date.now()) {
  if (!trace || !payload?.type) return turnLatencyDurations(trace);
  markTurnLatency(trace, 'firstEvent', atMs);
  if (payload.type === 'assistant-update') {
    markTurnLatency(trace, 'firstAssistant', atMs);
  }
  if (isTerminalTurnEvent(payload)) {
    markTurnLatency(trace, 'completed', atMs);
  }
  return turnLatencyDurations(trace);
}
