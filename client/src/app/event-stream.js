// Client side of /api/events (Server-Sent Events over fetch, not EventSource:
// fetch can send the Authorization header and the Last-Event-ID cursor, and
// lets us own reconnect timing).
//
// Liveness, from HAPI's reconnect contract:
// - the server writes a heartbeat every 25s; 90s without any frame means the
//   stream is dead even if the fetch never errored (iOS freezes a backgrounded
//   PWA and leaves the TCP connection half-open);
// - on returning to the foreground, a stream silent for >45s is replaced
//   immediately instead of waiting for the 90s rule;
// - a connect that has not produced its `resume` frame within 10s is retried;
// - reconnects back off 1s -> 30s with jitter, and pause while the page is
//   hidden (iOS would freeze them anyway).
//
// The cursor only advances after a frame was handed to onPayload, so a frame
// is never skipped; handlers must tolerate seeing one twice.

import { createBackoff } from './ws-backoff.js';

export const STREAM_STALE_MS = 90_000;
export const FOREGROUND_STALE_MS = 45_000;
export const CONNECT_TIMEOUT_MS = 10_000;
const WATCHDOG_INTERVAL_MS = 15_000;

// Parses `text` (which may end mid-frame) into complete frames; returns the
// unparsed remainder.
export function parseSseChunk(text, onFrame) {
  let rest = text.replace(/\r\n/g, '\n');
  let index;
  while ((index = rest.indexOf('\n\n')) >= 0) {
    const block = rest.slice(0, index);
    rest = rest.slice(index + 2);
    const frame = { id: null, event: 'message', data: '' };
    const data = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') data.push(value);
      else if (field === 'id') frame.id = value;
      else if (field === 'event') frame.event = value;
    }
    frame.data = data.join('\n');
    if (data.length || frame.event !== 'message') onFrame(frame);
  }
  return rest;
}

export function createEventStream({
  url = '/api/events',
  getToken,
  onPayload,
  onResume = () => {},
  onStateChange = () => {},
  onAuthRejected = () => {},
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  timers = { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a), setInterval: (...a) => setInterval(...a), clearInterval: (...a) => clearInterval(...a) },
  isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  backoff = createBackoff({ initial: 1000, max: 30_000, jitter: 0.25 })
}) {
  let stopped = true;
  let controller = null;
  let lastEventId = '';
  let lastFrameAt = 0;
  let connected = false;
  let reconnectTimer = null;
  let connectTimer = null;
  let watchdog = null;
  let generation = 0;

  const setState = (state) => onStateChange(state);

  function clearTimers() {
    timers.clearTimeout(reconnectTimer);
    timers.clearTimeout(connectTimer);
    reconnectTimer = null;
    connectTimer = null;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    if (isHidden()) return; // resumed by onForeground()
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoff.next());
  }

  function dropConnection() {
    generation += 1;
    connected = false;
    timers.clearTimeout(connectTimer);
    connectTimer = null;
    try {
      controller?.abort();
    } catch {
      // already settled
    }
    controller = null;
  }

  async function connect() {
    if (stopped) return;
    dropConnection();
    const myGeneration = generation;
    const myController = new AbortController();
    controller = myController;
    setState('connecting');
    connectTimer = timers.setTimeout(() => {
      if (myGeneration !== generation || connected) return;
      dropConnection();
      setState('disconnected');
      scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);

    const isCurrent = () => myGeneration === generation && !stopped;
    try {
      const headers = { accept: 'text/event-stream' };
      const token = getToken?.();
      if (token) headers.authorization = `Bearer ${token}`;
      if (lastEventId) headers['last-event-id'] = lastEventId;
      const response = await fetchImpl(url, { headers, cache: 'no-store', signal: myController.signal });
      if (!isCurrent()) return;
      if (response.status === 401) {
        onAuthRejected(token);
        throw new Error('event stream rejected: 401');
      }
      if (!response.ok || !response.body) {
        throw new Error(`event stream failed: ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (isCurrent()) {
        const { value, done } = await reader.read();
        if (done || !isCurrent()) break;
        lastFrameAt = now();
        buffer = parseSseChunk(buffer + decoder.decode(value, { stream: true }), (frame) => {
          if (!isCurrent()) return;
          if (frame.event === 'resume') {
            let resume = {};
            try {
              resume = JSON.parse(frame.data);
            } catch {
              // treat as fresh
            }
            connected = true;
            timers.clearTimeout(connectTimer);
            backoff.reset();
            setState('connected');
            onResume(resume.status || 'fresh');
            return;
          }
          let payload;
          try {
            payload = JSON.parse(frame.data);
          } catch {
            return;
          }
          onPayload(payload);
          if (frame.id) lastEventId = frame.id;
        });
      }
    } catch {
      // aborted, network error, or rejected — fall through to reconnect
    }
    if (!isCurrent()) return;
    dropConnection();
    setState('disconnected');
    scheduleReconnect();
  }

  // Replace the stream now (foreground, network change) if it is not
  // demonstrably alive.
  function onForeground() {
    if (stopped) return;
    const silentFor = now() - lastFrameAt;
    if (connected && silentFor <= FOREGROUND_STALE_MS) return;
    timers.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    backoff.reset();
    connect();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      lastFrameAt = now();
      watchdog = timers.setInterval(() => {
        if (connected && now() - lastFrameAt > STREAM_STALE_MS) {
          dropConnection();
          setState('disconnected');
          backoff.reset();
          connect();
        }
      }, WATCHDOG_INTERVAL_MS);
      connect();
    },
    stop() {
      stopped = true;
      clearTimers();
      timers.clearInterval(watchdog);
      dropConnection();
    },
    onForeground,
    get lastEventId() { return lastEventId; },
    get connected() { return connected; }
  };
}
