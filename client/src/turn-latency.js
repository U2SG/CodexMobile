// In-memory, duration-only telemetry for turns initiated by this tab. It must
// never capture prompts, rendered text, attachment paths, credentials, or other payloads.
const MAX_TRACES = 80;
const traces = new Map();

function defaultNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function finiteMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function duration(end, start) {
  const endMs = finiteMs(end);
  const startMs = finiteMs(start);
  if (endMs === null || startMs === null || endMs < startMs) return null;
  return Math.round((endMs - startMs) * 10) / 10;
}

function prune() {
  while (traces.size > MAX_TRACES) {
    traces.delete(traces.keys().next().value);
  }
}

function maybeLogFinished(trace) {
  if (!trace || trace.logged || !trace.outcome || trace.terminalAtMs === null) return;
  if (trace.firstAssistantFrameAtMs !== null && trace.firstTextAppliedAtMs === null) return;
  const logger = typeof trace.finishLogger === 'function' ? trace.finishLogger : console.info;
  trace.logged = true;
  logger('[turn-latency-client]', clientTurnLatencySnapshot(trace.turnId));
}

export function beginClientTurnLatency(turnId, atMs = defaultNow()) {
  if (!turnId) return null;
  const trace = {
    turnId: String(turnId),
    submitAtMs: finiteMs(atMs) ?? defaultNow(),
    sendResponseAtMs: null,
    firstWsEventAtMs: null,
    firstAssistantFrameAtMs: null,
    firstTextAppliedAtMs: null,
    terminalAtMs: null,
    outcome: null,
    finishLogger: null,
    logged: false
  };
  traces.delete(trace.turnId);
  traces.set(trace.turnId, trace);
  prune();
  return trace;
}

export function aliasClientTurnLatency(turnId, aliasTurnId) {
  const sourceId = String(turnId || '');
  const aliasId = String(aliasTurnId || '');
  const trace = traces.get(sourceId);
  if (!trace || !aliasId || aliasId === sourceId) return trace || null;
  traces.set(aliasId, trace);
  prune();
  return trace;
}

export function markClientTurnLatency(turnId, milestone, atMs = defaultNow()) {
  const trace = traces.get(String(turnId || ''));
  if (!trace) return null;
  const field = {
    sendResponse: 'sendResponseAtMs',
    firstWsEvent: 'firstWsEventAtMs',
    firstAssistantFrame: 'firstAssistantFrameAtMs',
    firstTextApplied: 'firstTextAppliedAtMs',
    terminal: 'terminalAtMs'
  }[milestone];
  const timestamp = finiteMs(atMs);
  if (!field || timestamp === null) return clientTurnLatencySnapshot(turnId);
  if (trace[field] === null) trace[field] = timestamp;
  maybeLogFinished(trace);
  return clientTurnLatencySnapshot(turnId);
}

export function clientTurnLatencySnapshot(turnId) {
  const trace = traces.get(String(turnId || ''));
  if (!trace) return null;
  return {
    turnId: trace.turnId,
    outcome: trace.outcome,
    submitToSendResponseMs: duration(trace.sendResponseAtMs, trace.submitAtMs),
    submitToFirstWsEventMs: duration(trace.firstWsEventAtMs, trace.submitAtMs),
    submitToFirstAssistantFrameMs: duration(trace.firstAssistantFrameAtMs, trace.submitAtMs),
    submitToFirstTextAppliedMs: duration(trace.firstTextAppliedAtMs, trace.submitAtMs),
    firstFrameToTextAppliedMs: duration(trace.firstTextAppliedAtMs, trace.firstAssistantFrameAtMs),
    submitToTerminalMs: duration(trace.terminalAtMs, trace.submitAtMs)
  };
}

export function finishClientTurnLatency(turnId, outcome = 'completed', atMs = defaultNow(), logger = console.info) {
  const trace = traces.get(String(turnId || ''));
  if (!trace) return null;
  trace.outcome = String(outcome || 'completed');
  trace.finishLogger = logger;
  markClientTurnLatency(turnId, 'terminal', atMs);
  maybeLogFinished(trace);
  return clientTurnLatencySnapshot(turnId);
}

export function listClientTurnLatencies() {
  return [...new Set(traces.values())].map((trace) => clientTurnLatencySnapshot(trace.turnId));
}

export function resetClientTurnLatencies() {
  traces.clear();
}
