// useDesktopBridge — encapsulates the desktop-IPC bridge probe state and
// the per-process runtime preference flags (ipcTurnsEnabled, etc.). What
// used to be three useCallbacks + one polling useEffect sprinkled across
// App.jsx is now one hook returning everything callers wire down to
// drawers, dialogs, and the WS hook (which still needs `setDesktopBridge`
// so push events from the server can refresh the same state slot).
//
// Stage 2 R12 — pure refactor; same /api/desktop/status + /api/runtime-prefs
// endpoints, same 30-second poll cadence, same optimistic PATCH + revert.

import { useCallback, useEffect, useState } from 'react';

import { apiFetch } from '../api.js';

export function useDesktopBridge({ authenticated }) {
  const [desktopBridge, setDesktopBridge] = useState(null);
  const [runtimePrefsState, setRuntimePrefsState] = useState({ ipcTurnsEnabled: true });

  const refreshDesktopBridge = useCallback(async ({ force = false } = {}) => {
    try {
      const data = await apiFetch(`/api/desktop/status${force ? '?force=1' : ''}`);
      setDesktopBridge(data);
    } catch {
      // ignore — keep last known state
    }
  }, []);

  const refreshRuntimePrefs = useCallback(async () => {
    try {
      const data = await apiFetch('/api/runtime-prefs');
      setRuntimePrefsState(data || {});
    } catch {
      // keep last known state
    }
  }, []);

  const handleSetRuntimePref = useCallback(async (key, value) => {
    setRuntimePrefsState((current) => ({ ...current, [key]: value }));
    try {
      const data = await apiFetch('/api/runtime-prefs', {
        method: 'PATCH',
        body: { [key]: value }
      });
      if (data?.prefs) setRuntimePrefsState(data.prefs);
    } catch (error) {
      window.alert(`设置失败：${error.message}`);
      refreshRuntimePrefs();
    }
  }, [refreshRuntimePrefs]);

  useEffect(() => {
    if (!authenticated) return undefined;
    refreshDesktopBridge();
    refreshRuntimePrefs();
    const id = window.setInterval(() => refreshDesktopBridge(), 30_000);
    // The 30s poll is the cold-state backstop. For warm interactions,
    // pull a fresh status the moment the tab regains focus or the
    // device's network comes back — both common signals that the
    // user is about to look at the bridge indicator and that the
    // last cached snapshot may be stale.
    const handleVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        refreshDesktopBridge({ force: true });
      }
    };
    const handleOnline = () => refreshDesktopBridge({ force: true });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline);
    }
    return () => {
      window.clearInterval(id);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
      }
    };
  }, [authenticated, refreshDesktopBridge, refreshRuntimePrefs]);

  return {
    desktopBridge,
    setDesktopBridge,
    runtimePrefsState,
    refreshDesktopBridge,
    refreshRuntimePrefs,
    handleSetRuntimePref
  };
}
