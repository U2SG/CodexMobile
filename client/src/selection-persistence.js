export const SELECTED_PROJECT_KEY = 'codexmobile.selectedProjectId';
export const SELECTED_SESSION_KEY = 'codexmobile.selectedSessionId';

function storageOrNull(storage = globalThis.localStorage) {
  return storage && typeof storage.getItem === 'function' ? storage : null;
}

function storedText(storage, key) {
  try {
    return String(storage?.getItem?.(key) || '').trim();
  } catch {
    return '';
  }
}

function isDraftSessionLike(session) {
  const id = String(session?.id || '');
  return Boolean(session?.draft || id.startsWith('draft-'));
}

export function readStoredSelection(storage = globalThis.localStorage) {
  const source = storageOrNull(storage);
  if (!source) {
    return { projectId: '', sessionId: '' };
  }
  return {
    projectId: storedText(source, SELECTED_PROJECT_KEY),
    sessionId: storedText(source, SELECTED_SESSION_KEY)
  };
}

export function rememberSelectedSession(session, storage = globalThis.localStorage) {
  const target = storageOrNull(storage);
  if (!target || !session?.id || isDraftSessionLike(session)) {
    return;
  }
  try {
    target.setItem(SELECTED_SESSION_KEY, String(session.id));
    if (session.projectId) {
      target.setItem(SELECTED_PROJECT_KEY, String(session.projectId));
    }
  } catch {
    // Storage can be unavailable in private/embedded contexts.
  }
}

export function preferredProjectFromStoredSelection(projects = [], {
  preserveSelection = false,
  currentProject = null,
  storedProjectId = ''
} = {}) {
  if (preserveSelection && currentProject?.id) {
    const current = projects.find((project) => project.id === currentProject.id);
    if (current) {
      return current;
    }
  }
  if (storedProjectId) {
    const stored = projects.find((project) => project.id === storedProjectId);
    if (stored) {
      return stored;
    }
  }
  return (
    projects.find((project) => project.name.toLowerCase() === 'codexmobile') ||
    projects.find((project) => project.path.toLowerCase().includes('codexmobile')) ||
    projects[0] ||
    null
  );
}

export function selectedSessionFromStoredSelection(sessions = [], {
  preserveSelection = false,
  currentSession = null,
  storedSessionId = '',
  restoreStored = true,
  chooseLatest = true
} = {}) {
  if (preserveSelection && currentSession?.id) {
    if (isDraftSessionLike(currentSession)) {
      return currentSession;
    }
    const current = sessions.find((session) => session.id === currentSession.id);
    if (current) {
      return current;
    }
  }
  if (restoreStored && storedSessionId) {
    const stored = sessions.find((session) => session.id === storedSessionId);
    if (stored) {
      return stored;
    }
  }
  if (!chooseLatest) {
    return null;
  }
  return sessions.find((session) => !session.pinned) || sessions[0] || null;
}
