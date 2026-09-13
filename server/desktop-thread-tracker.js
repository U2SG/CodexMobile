// Maintains a long-lived IPC connection to Codex Desktop and tracks which
// conversation IDs are currently being followed (i.e. which threads are
// "open" in the desktop app). thread-follower-start-turn / steer / interrupt
// only succeed against threads in this set, so the tracker is the source of
// truth for "IPC eligibility" in the chat-send routing.

import { DesktopIpcClient, desktopIpcSocketPath } from './desktop-ipc-client.js';

// 1.5s initial means "desktop app restart → tracker has re-subscribed to
// thread-stream-state-changed broadcasts" in ~1.6s (measured by
// scripts/probe-desktop-bridge-restart.mjs). The tracker owns the openThreadIds
// set which gates desktop-thread-aware chat-send routing (thread-follower-
// start-turn / steer / interrupt only succeed against IDs in this set) — so
// faster tracker recovery = faster correct routing after a desktop restart.
// Note: this does NOT directly speed up the desktopBridge.connected indicator
// the PWA renders; that flag comes from bridgeStatusCache.getStatus() in
// desktop-bridge.js (independent probeDesktopIpc path, 2.5s TTL). Cost of
// being more aggressive here: marginally more connect attempts when the
// desktop is genuinely not running (each is one local named-pipe/UNIX-socket
// open against an OS object).
const DEFAULT_RECONNECT_MS = 1_500;
const DEFAULT_MAX_RECONNECT_MS = 30_000;
const RELEVANT_BROADCAST_METHODS = new Set([
  'thread-stream-state-changed'
]);

export function createDesktopThreadTracker({
  socketPath = desktopIpcSocketPath(),
  versionStore = null,
  reconnectMs = DEFAULT_RECONNECT_MS,
  maxReconnectMs = DEFAULT_MAX_RECONNECT_MS
} = {}) {
  let openIds = new Set();
  let listeners = new Set();
  let activityListeners = new Set();
  let connectionListeners = new Set();
  let client = null;
  let pendingClient = null;
  let reconnectTimer = null;
  let stopped = true;
  let connecting = false;
  let backoff = reconnectMs;
  let lastConnectionState = null; // null | 'connected' | 'disconnected'

  function emit() {
    const snapshot = new Set(openIds);
    for (const fn of listeners) {
      try { fn(snapshot); } catch (error) { console.warn('[thread-tracker] listener threw:', error.message); }
    }
  }

  function emitConnectionState(state) {
    if (state === lastConnectionState) return;
    lastConnectionState = state;
    for (const fn of connectionListeners) {
      try { fn({ connected: state === 'connected' }); }
      catch (error) { console.warn('[thread-tracker] connection listener threw:', error.message); }
    }
  }

  function handleBroadcast(message) {
    if (!RELEVANT_BROADCAST_METHODS.has(message.method)) return;
    const conversationId = message?.params?.conversationId;
    if (!conversationId || typeof conversationId !== 'string') return;
    if (!openIds.has(conversationId)) {
      openIds.add(conversationId);
      emit();
    }
    const change = message.params?.change;
    for (const fn of activityListeners) {
      try { fn({ conversationId, change, raw: message }); } catch (error) { console.warn('[thread-tracker] activity listener threw:', error.message); }
    }
  }

  function handleClose() {
    client = null;
    emitConnectionState('disconnected');
    if (stopped) return;
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(backoff, maxReconnectMs);
    backoff = Math.min(Math.floor(backoff * 1.6) + 100, maxReconnectMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  async function connect() {
    if (stopped || connecting || (client && client.socket?.writable)) return;
    connecting = true;
    // Reset open set on each fresh connection — desktop will replay snapshots.
    if (openIds.size) {
      openIds = new Set();
      emit();
    }
    const next = new DesktopIpcClient({
      socketPath,
      versionStore,
      onBroadcast: handleBroadcast,
      onClose: handleClose
    });
    pendingClient = next;
    try {
      await next.connect({ timeoutMs: Math.min(maxReconnectMs, 5000) });
      if (stopped) {
        next.close();
        return;
      }
      client = next;
      backoff = reconnectMs; // reset on successful connect
      emitConnectionState('connected');
    } catch (error) {
      next.close();
      if (stopped) return;
      // ENOENT just means desktop isn't running — silent until it changes.
      if (error?.code !== 'ENOENT' && !/ENOENT/.test(error?.message || '')) {
        console.warn(`[thread-tracker] connect failed: ${error.message}`);
      }
      emitConnectionState('disconnected');
      scheduleReconnect();
    } finally {
      if (pendingClient === next) {
        pendingClient = null;
      }
      connecting = false;
    }
  }

  return {
    async start() {
      if (!stopped) return;
      stopped = false;
      backoff = reconnectMs;
      await connect();
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      pendingClient?.close();
      pendingClient = null;
      client?.close();
      client = null;
    },
    isThreadOpen(id) {
      return typeof id === 'string' && openIds.has(id);
    },
    getOpenThreadIds() {
      return [...openIds];
    },
    onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    onActivity(callback) {
      activityListeners.add(callback);
      return () => activityListeners.delete(callback);
    },
    onConnectionChange(callback) {
      connectionListeners.add(callback);
      // Replay last known state so subscribers don't miss a transition
      // that happened before they subscribed.
      if (lastConnectionState) {
        try { callback({ connected: lastConnectionState === 'connected' }); }
        catch (error) { console.warn('[thread-tracker] connection listener threw:', error.message); }
      }
      return () => connectionListeners.delete(callback);
    }
  };
}
