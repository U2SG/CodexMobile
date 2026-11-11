import { useCallback, useEffect, useState } from 'react';

import { apiFetch } from '../api.js';

// Polls /api/runs/overview: often while the sheet is open, slowly otherwise
// so the top-bar pill stays roughly current; never while the tab is hidden.
const OPEN_INTERVAL_MS = 3000;
const IDLE_INTERVAL_MS = 15000;

export function useRunsOverview({ authenticated, open }) {
  const [runs, setRuns] = useState([]);

  const refresh = useCallback(async () => {
    if (document.hidden) return;
    try {
      const data = await apiFetch('/api/runs/overview');
      setRuns(Array.isArray(data.runs) ? data.runs : []);
    } catch {
      // Keep the last list; the connection card reports outages.
    }
  }, []);

  useEffect(() => {
    if (!authenticated) {
      setRuns([]);
      return undefined;
    }
    refresh();
    const timer = window.setInterval(refresh, open ? OPEN_INTERVAL_MS : IDLE_INTERVAL_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [authenticated, open, refresh]);

  return { runs, refresh };
}
