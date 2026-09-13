// useSessionActions — session-list interactions (toggle, select, load,
// rename, delete) extracted from App.jsx Stage 2 R5. Pure refactor: same
// logic, same behavior, same race-guards.
//
// Returns:
//   loadSessions(project, options)       — fetches a project's session list and
//                                          (when options.chooseLatest) picks the
//                                          newest non-pinned session unless
//                                          restoreStored is explicitly true.
//                                          Accepts legacy boolean form too.
//   handleToggleProject(project)         — expand/collapse a project row; first
//                                          expand triggers loadSessions.
//   handleSelectSession(session)         — switch to a session and load its
//                                          messages, with an A→B→A race guard
//                                          so a slow earlier fetch can't
//                                          overwrite the user's intended view.
//   handleRenameSession(project, session) — PATCH new title via /api/projects/...
//                                          /sessions/:id; falls back to local-
//                                          only update for draft sessions.
//   handleDeleteSession(project, session) — DELETE via /api/projects/.../sessions/:id;
//                                          clears composer state if the deleted
//                                          session was current. Refuses while
//                                          the session is running (server returns
//                                          409 with "running" in the message).

import { useCallback } from 'react';

import { apiFetch } from '../api.js';
import {
  rememberSelectedSession,
  selectedSessionFromStoredSelection
} from '../selection-persistence.js';
import { isDraftSession, sessionMessagesPath } from './session-utils.js';

export function useSessionActions({
  selectedProject,
  selectedProjectRef,
  selectedSessionRef,
  expandedProjectIds,
  sessionsByProject,
  setSelectedProject,
  setSelectedSession,
  setSessionsByProject,
  setMessages,
  setExpandedProjectIds,
  setLoadingProjectId,
  setProjects,
  setPinFolders,
  setDrawerOpen,
  setAttachments,
  setInput
}) {
  const loadSessions = useCallback(async (project, options = true) => {
    // Backwards-compat: callers used to pass a boolean `chooseLatest`. Accept
    // both that and the options object form.
    const opts = typeof options === 'boolean'
      ? { chooseLatest: options, storedSessionId: '', restoreStored: true }
      : { chooseLatest: true, storedSessionId: '', restoreStored: true, ...options };

    if (!project) {
      setSelectedSession(null);
      setMessages([]);
      return;
    }
    setLoadingProjectId(project.id);
    try {
      const data = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`);
      const nextSessions = data.sessions || [];
      setSessionsByProject((current) => ({ ...current, [project.id]: nextSessions }));
      if (opts.chooseLatest) {
        // Cold start uses the newest non-pinned session; explicit restore paths
        // may still opt into storedSessionId.
        const next = selectedSessionFromStoredSelection(nextSessions, {
          storedSessionId: opts.storedSessionId,
          restoreStored: opts.restoreStored,
          chooseLatest: true
        });
        setSelectedSession(next);
        if (next) {
          const messageData = await apiFetch(sessionMessagesPath(next.id));
          // Race guard: another loadSessions / handleSelectSession may have
          // run during the fetch. Only paint if `next` is still selected.
          if (selectedSessionRef.current?.id === next.id) {
            setMessages(messageData.messages || []);
          }
        } else {
          setMessages([]);
        }
      } else {
        setSelectedSession(null);
        setMessages([]);
      }
    } finally {
      setLoadingProjectId((current) => (current === project.id ? null : current));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleOpenProject(project) {
    if (!project?.id) return;
    setExpandedProjectIds((current) => ({ ...current, [project.id]: true }));
    const projectChanged = selectedProject?.id !== project.id;
    setSelectedProject(project);
    if (projectChanged) {
      setSelectedSession(null);
      setMessages([]);
    }
    if (!sessionsByProject[project.id]?.length) {
      await loadSessions(project, false);
    }
  }

  async function handleToggleProject(project) {
    const isExpanded = Boolean(expandedProjectIds[project.id]);
    if (isExpanded) {
      setExpandedProjectIds((current) => {
        const next = { ...current };
        delete next[project.id];
        return next;
      });
      return;
    }

    await handleOpenProject(project);
  }

  async function handleSelectSession(session, project = null) {
    // When a caller resolves the session's owning project (e.g. search jumps
    // across projects), switch the app's project context so the top bar and
    // Git scope follow the session. Guarded so the normal in-project drawer
    // flow — which passes no project — is untouched. Unmatched cwd
    // (worktree / unlisted project) leaves the current project as-is.
    if (project?.id && project.id !== selectedProjectRef.current?.id) {
      setSelectedProject(project);
    }
    setSelectedSession(session);
    rememberSelectedSession(session);
    if (isDraftSession(session)) {
      setMessages([]);
      setDrawerOpen(false);
      return;
    }
    try {
      const data = await apiFetch(sessionMessagesPath(session.id));
      // If the user tapped another session before this request returned, drop
      // the response — otherwise a slow A→B→A race would overwrite the user's
      // intended view (B) with the slower-returning history (A).
      if (selectedSessionRef.current?.id !== session.id) {
        return;
      }
      setMessages(data.messages || []);
      setDrawerOpen(false);
    } catch (error) {
      console.error('[sessions] Failed to load messages:', error);
      if (selectedSessionRef.current?.id === session.id) {
        setMessages([]);
        setDrawerOpen(false);
      }
    }
  }

  async function refreshProjectSessions(project) {
    if (!project?.id) {
      return;
    }
    const [projectData, sessionData] = await Promise.all([
      apiFetch('/api/projects'),
      apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`)
    ]);
    const nextProjects = projectData.projects || [];
    setProjects(nextProjects);
    setPinFolders(projectData.pinFolders || []);
    setSessionsByProject((current) => ({ ...current, [project.id]: sessionData.sessions || [] }));
    const nextSelectedProject = nextProjects.find((item) => item.id === selectedProjectRef.current?.id);
    if (nextSelectedProject) {
      setSelectedProject(nextSelectedProject);
    }
  }

  async function handleRenameSession(project, session) {
    if (!project?.id || !session?.id) {
      return;
    }

    const currentTitle = session.title || '对话';
    const nextTitle = window.prompt('重命名线程', currentTitle)?.trim().slice(0, 52);
    if (!nextTitle || nextTitle === currentTitle) {
      return;
    }

    const applyLocalTitle = () => {
      setSessionsByProject((current) => ({
        ...current,
        [project.id]: (current[project.id] || []).map((item) =>
          item.id === session.id ? { ...item, title: nextTitle, titleLocked: true } : item
        )
      }));
      if (selectedSessionRef.current?.id === session.id) {
        setSelectedSession((current) => (current ? { ...current, title: nextTitle, titleLocked: true } : current));
      }
    };

    if (isDraftSession(session)) {
      applyLocalTitle();
      return;
    }

    try {
      await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions/${encodeURIComponent(session.id)}`, {
        method: 'PATCH',
        body: { title: nextTitle }
      });
      applyLocalTitle();
      await refreshProjectSessions(project);
    } catch (error) {
      window.alert(`重命名失败：${error.message}`);
    }
  }

  async function handleDeleteSession(project, session) {
    if (!project?.id || !session?.id) {
      return;
    }

    const title = session.title || '对话';
    const confirmed = window.confirm(
      `从 CodexMobile 隐藏线程“${title}”？不会影响 Codex App 的原始会话。`
    );
    if (!confirmed) {
      return;
    }

    const removeLocalSession = () => {
      setSessionsByProject((current) => ({
        ...current,
        [project.id]: (current[project.id] || []).filter((item) => item.id !== session.id)
      }));
      if (selectedSessionRef.current?.id === session.id) {
        setSelectedSession(null);
        setMessages([]);
        setAttachments([]);
        setInput('');
      }
    };

    if (isDraftSession(session)) {
      removeLocalSession();
      return;
    }

    try {
      await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions/${encodeURIComponent(session.id)}`, {
        method: 'DELETE'
      });
      removeLocalSession();
      await refreshProjectSessions(project);
    } catch (error) {
      const message = String(error.message || '');
      window.alert(
        message.toLowerCase().includes('running')
          ? '线程正在运行，稍后再删除。'
          : `删除失败：${message}`
      );
    }
  }

  async function handleArchiveProject(project) {
    if (!project?.id) {
      return false;
    }
    const confirmed = window.confirm(
      `从移动端归档项目“${project.name || project.id}”？不会删除项目目录或 Codex 原始会话。`
    );
    if (!confirmed) {
      return false;
    }

    try {
      const data = await apiFetch('/api/projects/archive', {
        method: 'POST',
        body: { project }
      });
      const nextProjects = data.projects || [];
      setProjects(nextProjects);
      setPinFolders(data.pinFolders || []);
      setSessionsByProject((current) => {
        const next = { ...current };
        delete next[project.id];
        return next;
      });
      setExpandedProjectIds((current) => {
        const next = { ...current };
        delete next[project.id];
        return next;
      });
      if (selectedProjectRef.current?.id === project.id) {
        const nextProject = nextProjects[0] || null;
        setSelectedProject(nextProject);
        setSelectedSession(null);
        setMessages([]);
        setAttachments([]);
        setInput('');
        if (nextProject) {
          setExpandedProjectIds((current) => ({ ...current, [nextProject.id]: true }));
          await loadSessions(nextProject, { chooseLatest: true, restoreStored: false });
        }
      }
      return true;
    } catch (error) {
      window.alert(`归档失败：${error.message}`);
      return false;
    }
  }

  async function handleRestoreProject(project) {
    if (!project?.id) {
      return false;
    }
    try {
      const data = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/restore`, {
        method: 'POST'
      });
      setProjects(data.projects || []);
      setPinFolders(data.pinFolders || []);
      return true;
    } catch (error) {
      window.alert(`恢复失败：${error.message}`);
      return false;
    }
  }

  return {
    loadSessions,
    handleOpenProject,
    handleToggleProject,
    handleSelectSession,
    handleRenameSession,
    handleDeleteSession,
    handleArchiveProject,
    handleRestoreProject
  };
}
