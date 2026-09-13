// usePinActions — owns every pin / pin-folder mutation handler that
// used to live as a loose `async function handle*` block inside App.jsx.
// Pulled out as Stage 2 R10: pure refactor, same network calls, same
// optimistic updates, same window.alert / window.prompt error surface.
//
// The hook also absorbs the two top-level helpers that only the pin
// flow used — `sortSessionsForDisplay` (kept private here) and
// `patchSessionInProjects` (exposed via the hook return for callers
// that need to patch a session inline; currently no caller does, but
// the optimistic toggle and revert paths above rely on it).
//
// Inputs:
//   pinFolders                 — current folder list (read by handlePromptMoveToFolder)
//   selectedProjectRef         — ref to the currently selected project
//   sessionsByProject          — projects → sessions map (used to know
//                                which project ids need a re-list)
//   setPinFolders              — setter for folder list
//   setSessionsByProject       — setter for session map
//   setSelectedSession         — setter for the highlighted session
//   loadPinnedSessions         — refresher for the global pinned list
//
// Returns the seven handlers App.jsx wires into the drawer / thread
// rows. Each handler keeps its original optimistic+revert semantics so
// the UX is identical to the inline version.

import { apiFetch } from '../api.js';
import { isDraftSession } from './session-utils.js';

function sortSessionsForDisplay(sessions) {
  return [...sessions].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) {
      return new Date(b.pinnedAt || 0) - new Date(a.pinnedAt || 0);
    }
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
}

function patchSessionInProjects(current, sessionId, patcher) {
  if (!sessionId) return current;
  let changed = false;
  const next = {};
  for (const [projectId, sessions] of Object.entries(current)) {
    let projectChanged = false;
    const patched = sessions.map((session) => {
      if (session.id !== sessionId) return session;
      projectChanged = true;
      changed = true;
      return patcher(session);
    });
    next[projectId] = projectChanged ? sortSessionsForDisplay(patched) : sessions;
  }
  return changed ? next : current;
}

export function usePinActions({
  pinFolders,
  selectedProjectRef,
  sessionsByProject,
  setPinFolders,
  setSessionsByProject,
  setSelectedSession,
  loadPinnedSessions
}) {
  async function refreshPinnedSessionLists(folderIdHint) {
    const projectIds = new Set();
    if (selectedProjectRef.current?.id) projectIds.add(selectedProjectRef.current.id);
    Object.keys(sessionsByProject).forEach((id) => projectIds.add(id));
    await Promise.all(
      [...projectIds].map((projectId) =>
        apiFetch(`/api/projects/${encodeURIComponent(projectId)}/sessions`)
          .then((data) => {
            setSessionsByProject((current) => ({ ...current, [projectId]: data.sessions || [] }));
          })
          .catch(() => null)
      )
    );
    void folderIdHint;
  }

  async function handleTogglePin(project, session) {
    if (!session?.id || isDraftSession(session)) return;
    const isPinned = Boolean(session.pinned);
    const nextPinnedAt = isPinned ? null : new Date().toISOString();
    const optimisticPatch = {
      pinned: !isPinned,
      pinnedAt: nextPinnedAt,
      folderId: isPinned ? null : session.folderId || null
    };
    const revertPatch = {
      pinned: isPinned,
      pinnedAt: session.pinnedAt || null,
      folderId: session.folderId || null
    };
    setSessionsByProject((current) =>
      patchSessionInProjects(current, session.id, (item) => ({ ...item, ...optimisticPatch }))
    );
    setSelectedSession((current) => (current?.id === session.id ? { ...current, ...optimisticPatch } : current));
    try {
      const result = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/pin`, {
        method: isPinned ? 'DELETE' : 'POST',
        body: isPinned ? undefined : {}
      });
      if (!isPinned && result?.pin) {
        const confirmedPatch = {
          pinned: true,
          pinnedAt: result.pin.pinnedAt || nextPinnedAt,
          folderId: result.pin.folderId || null
        };
        setSessionsByProject((current) =>
          patchSessionInProjects(current, session.id, (item) => ({ ...item, ...confirmedPatch }))
        );
        setSelectedSession((current) => (current?.id === session.id ? { ...current, ...confirmedPatch } : current));
      }
      const data = await apiFetch('/api/pin-folders');
      if (Array.isArray(data?.folders)) setPinFolders(data.folders);
      await refreshPinnedSessionLists();
      await loadPinnedSessions();
    } catch (error) {
      setSessionsByProject((current) =>
        patchSessionInProjects(current, session.id, (item) => ({ ...item, ...revertPatch }))
      );
      setSelectedSession((current) => (current?.id === session.id ? { ...current, ...revertPatch } : current));
      window.alert(`${isPinned ? '取消置顶' : '置顶'}失败：${error.message}`);
    }
  }

  async function handleMoveSessionToFolder(session, folderId) {
    if (!session?.id || !session.pinned) return;
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/pin`, {
        method: 'PATCH',
        body: { folderId: folderId || null }
      });
      await refreshPinnedSessionLists();
      await loadPinnedSessions();
    } catch (error) {
      window.alert(`移动失败：${error.message}`);
    }
  }

  async function handleCreatePinFolder() {
    const name = window.prompt('新建置顶分组', '')?.trim().slice(0, 32);
    if (!name) return null;
    try {
      const data = await apiFetch('/api/pin-folders', { method: 'POST', body: { name } });
      const list = await apiFetch('/api/pin-folders');
      if (Array.isArray(list?.folders)) setPinFolders(list.folders);
      return data?.folder || null;
    } catch (error) {
      window.alert(`新建失败：${error.message}`);
      return null;
    }
  }

  async function handleRenamePinFolder(folder) {
    const name = window.prompt('重命名置顶分组', folder.name)?.trim().slice(0, 32);
    if (!name || name === folder.name) return;
    try {
      await apiFetch(`/api/pin-folders/${encodeURIComponent(folder.id)}`, {
        method: 'PATCH',
        body: { name }
      });
      const list = await apiFetch('/api/pin-folders');
      if (Array.isArray(list?.folders)) setPinFolders(list.folders);
    } catch (error) {
      window.alert(`重命名失败：${error.message}`);
    }
  }

  async function handleToggleFolderCollapsed(folder) {
    setPinFolders((current) =>
      current.map((item) => (item.id === folder.id ? { ...item, collapsed: !item.collapsed } : item))
    );
    try {
      await apiFetch(`/api/pin-folders/${encodeURIComponent(folder.id)}`, {
        method: 'PATCH',
        body: { collapsed: !folder.collapsed }
      });
    } catch (error) {
      setPinFolders((current) =>
        current.map((item) => (item.id === folder.id ? { ...item, collapsed: folder.collapsed } : item))
      );
    }
  }

  async function handleDeletePinFolder(folder) {
    if (!window.confirm(`删除置顶分组"${folder.name}"？里面的会话仍会保留置顶。`)) return;
    try {
      await apiFetch(`/api/pin-folders/${encodeURIComponent(folder.id)}`, { method: 'DELETE' });
      const list = await apiFetch('/api/pin-folders');
      if (Array.isArray(list?.folders)) setPinFolders(list.folders);
      await refreshPinnedSessionLists();
      await loadPinnedSessions();
    } catch (error) {
      window.alert(`删除失败：${error.message}`);
    }
  }

  async function handlePromptMoveToFolder(session) {
    let folders = pinFolders;
    if (!folders.length) {
      const created = await handleCreatePinFolder();
      if (!created) return;
      folders = [created];
    }
    const labels = folders.map((folder, idx) => `${idx + 1}. ${folder.name}`).join('\n');
    const input = window.prompt(
      `选择置顶分组 (输入序号，0 表示未分组)：\n${labels}`,
      session.folderId ? String(folders.findIndex((f) => f.id === session.folderId) + 1) : '0'
    );
    if (input === null) return;
    const trimmed = input.trim();
    if (trimmed === '0' || trimmed === '') {
      await handleMoveSessionToFolder(session, null);
      return;
    }
    const index = Number(trimmed) - 1;
    const target = folders[index];
    if (!target) return;
    await handleMoveSessionToFolder(session, target.id);
  }

  return {
    handleTogglePin,
    handleMoveSessionToFolder,
    handleCreatePinFolder,
    handleRenamePinFolder,
    handleToggleFolderCollapsed,
    handleDeletePinFolder,
    handlePromptMoveToFolder
  };
}
