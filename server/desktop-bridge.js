import { probeDesktopIpc } from './desktop-ipc-client.js';

const DEFAULT_TTL_MS = 2500;

export function createBridgeStatusCache({
  probe = probeDesktopIpc,
  clock = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS
} = {}) {
  let cached = null;
  let inflight = null;
  const changeListeners = new Set();

  function statusChanged(prev, next) {
    if (!prev) return true;
    return prev.connected !== next.connected || prev.reason !== next.reason || prev.mode !== next.mode;
  }

  function emitChange(next) {
    for (const fn of changeListeners) {
      try { fn(next); } catch (error) { console.warn('[bridge-cache] listener threw:', error.message); }
    }
  }

  async function refresh() {
    const prev = cached;
    try {
      const result = await probe();
      cached = {
        connected: Boolean(result?.connected),
        mode: result?.mode || 'desktop-ipc',
        reason: result?.reason || null,
        socketPath: result?.socketPath || null,
        checkedAt: clock()
      };
    } catch (error) {
      cached = {
        connected: false,
        mode: 'desktop-ipc',
        reason: error?.message || 'probe failed',
        socketPath: null,
        checkedAt: clock()
      };
    }
    if (statusChanged(prev, cached)) emitChange(cached);
    return cached;
  }

  async function getStatus({ force = false } = {}) {
    if (!force && cached && clock() - cached.checkedAt <= ttlMs) {
      return cached;
    }
    if (inflight) return inflight;
    inflight = refresh().finally(() => { inflight = null; });
    return inflight;
  }

  function getCachedStatus() {
    return cached;
  }

  function onChange(callback) {
    changeListeners.add(callback);
    return () => changeListeners.delete(callback);
  }

  return { getStatus, getCachedStatus, onChange };
}
