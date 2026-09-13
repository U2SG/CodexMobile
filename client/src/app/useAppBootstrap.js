// useAppBootstrap — owns the initial-load orchestration and exposes the
// loaders App needs to call from handlers (e.g. /api/sync button, pin
// toggle). Pure refactor — same logic, same behavior. Extracted from
// App.jsx Stage 2 R4.
//
// On mount the hook:
//   1. fetches /api/status and seeds status + authenticated state;
//   2. if authenticated, loads projects (which prefers the last-viewed
//      project + session from localStorage), pinned sessions, and the
//      project's session list;
//   3. fires POST /api/sync in the background and, when it returns,
//      reloads status + projects with preserveSelection: true so the
//      sync result doesn't yank the user out of whatever they navigated
//      to during the wait.
//
// Returns: { loadStatus, loadProjects, loadPinnedSessions } so App can
// re-trigger them on user actions (manual /api/sync button, post-pin
// refresh, etc.).
//
// loadSessions is passed in as a dependency — it stays in App.jsx until
// Stage 2 R5 (useSessionActions) extracts it.

import { useCallback, useEffect, useState } from 'react';

import { apiFetch, clearToken } from '../api.js';
import {
  preferredProjectFromStoredSelection,
  readStoredSelection
} from '../selection-persistence.js';

export function useAppBootstrap({
  setStatus,
  setAuthenticated,
  setProjects,
  setPinFolders,
  setPinnedSessions,
  setSelectedProject,
  setSessionsByProject,
  setExpandedProjectIds,
  selectedProjectRef,
  syncActiveRunsFromStatus,
  loadSessions
}) {
  const [syncing, setSyncing] = useState(false);

  const loadStatus = useCallback(async () => {
    const data = await apiFetch('/api/status');
    setStatus(data);
    setAuthenticated(Boolean(data.auth?.authenticated));
    syncActiveRunsFromStatus(data);
    return data;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadPinnedSessions = useCallback(async () => {
    try {
      const data = await apiFetch('/api/pinned-sessions');
      setPinnedSessions(Array.isArray(data?.sessions) ? data.sessions : []);
      if (Array.isArray(data?.folders)) setPinFolders(data.folders);
    } catch {
      // ignore — keep last known state
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadProjects = useCallback(async ({ preserveSelection = false } = {}) => {
    const data = await apiFetch('/api/projects');
    const list = data.projects || [];
    setProjects(list);
    setPinFolders(data.pinFolders || []);

    // Refresh-only path: keep whatever project + session the user is currently
    // viewing, just update the underlying lists. Stops the post-sync bootstrap
    // and the manual sync button from yanking the user back to the latest
    // session and restarting the scroll position.
    if (preserveSelection) {
      const currentProject = selectedProjectRef.current;
      if (currentProject) {
        const refreshed = list.find((p) => p.id === currentProject.id) || null;
        if (refreshed) {
          setSelectedProject(refreshed);
        }
        try {
          const sessionData = await apiFetch(
            `/api/projects/${encodeURIComponent(currentProject.id)}/sessions`
          );
          setSessionsByProject((current) => ({
            ...current,
            [currentProject.id]: sessionData.sessions || []
          }));
        } catch {
          // ignore — keep last known sessions list
        }
      }
      await loadPinnedSessions();
      return;
    }

    // Initial bootstrap path: keep the last project, but do not stick to the
    // last session. Pick the newest non-pinned session so mobile opens on the
    // current work instead of an old remembered thread.
    const stored = readStoredSelection();
    const preferred = preferredProjectFromStoredSelection(list, {
      storedProjectId: stored.projectId
    });
    setSelectedProject(preferred);
    if (preferred) {
      setExpandedProjectIds((current) => ({ ...current, [preferred.id]: true }));
    }
    await Promise.all([
      loadSessions(preferred, { storedSessionId: stored.sessionId, restoreStored: false }),
      loadPinnedSessions()
    ]);
  }, [loadSessions, loadPinnedSessions]);

  const bootstrap = useCallback(async () => {
    try {
      const currentStatus = await loadStatus();
      if (currentStatus.auth?.authenticated) {
        await loadProjects();
        setSyncing(true);
        apiFetch('/api/sync', { method: 'POST' })
          .then(async () => {
            await loadStatus();
            // Initial bootstrap already picked the preferred project + latest
            // session. The post-sync refresh must NOT re-pick or it will yank
            // the user out of whatever they navigated to during the sync wait.
            await loadProjects({ preserveSelection: true });
          })
          .catch(() => null)
          .finally(() => setSyncing(false));
      }
    } catch (error) {
      if (String(error.message).includes('Pairing')) {
        clearToken();
        setAuthenticated(false);
      }
    }
  }, [loadProjects, loadStatus]);

  // User-initiated sync from the drawer button — same POST + reload sequence
  // as the post-mount bootstrap path above, but always preserves the user's
  // current selection (they pressed the button while looking at something
  // specific and shouldn't be yanked back to the latest session).
  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      await apiFetch('/api/sync', { method: 'POST' });
      await loadStatus();
      await loadProjects({ preserveSelection: true });
    } finally {
      setSyncing(false);
    }
  }, [loadStatus, loadProjects]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  return { loadStatus, loadProjects, loadPinnedSessions, bootstrap, syncing, handleSync };
}
