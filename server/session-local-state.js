import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STATE_DIR = path.join(process.cwd(), '.codexmobile', 'state');
const DEFAULT_DELETED_MESSAGES_PATH = path.join(DEFAULT_STATE_DIR, 'deleted-messages.json');
const DEFAULT_HIDDEN_SESSIONS_PATH = path.join(DEFAULT_STATE_DIR, 'hidden-sessions.json');
const DEFAULT_HIDDEN_PROJECTS_PATH = path.join(DEFAULT_STATE_DIR, 'hidden-projects.json');

function emptyDeletedMessagesState() {
  return { version: 1, sessions: {} };
}

function emptyHiddenSessionsState() {
  return { version: 1, sessions: {} };
}

function emptyHiddenProjectsState() {
  return { version: 1, projects: {} };
}

export function filterDeletedMessages(messages, deletedIds) {
  if (!deletedIds.size) {
    return messages;
  }
  return messages.filter((message) => !deletedIds.has(String(message.id || '')));
}

export function createSessionLocalState({
  deletedMessagesPath = DEFAULT_DELETED_MESSAGES_PATH,
  hiddenSessionsPath = DEFAULT_HIDDEN_SESSIONS_PATH,
  hiddenProjectsPath = DEFAULT_HIDDEN_PROJECTS_PATH
} = {}) {
  async function readDeletedMessagesState() {
    try {
      const raw = await fs.readFile(deletedMessagesPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        version: 1,
        sessions: parsed && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
          ? parsed.sessions
          : {}
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[sessions] Failed to read deleted message state:', error.message);
      }
      return emptyDeletedMessagesState();
    }
  }

  async function writeDeletedMessagesState(state) {
    await fs.mkdir(path.dirname(deletedMessagesPath), { recursive: true });
    await fs.writeFile(
      deletedMessagesPath,
      JSON.stringify({ version: 1, sessions: state.sessions || {} }, null, 2),
      'utf8'
    );
  }

  async function readHiddenSessionsState() {
    try {
      const raw = await fs.readFile(hiddenSessionsPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        version: 1,
        sessions: parsed && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
          ? parsed.sessions
          : {}
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[sessions] Failed to read hidden session state:', error.message);
      }
      return emptyHiddenSessionsState();
    }
  }

  async function writeHiddenSessionsState(state) {
    await fs.mkdir(path.dirname(hiddenSessionsPath), { recursive: true });
    await fs.writeFile(
      hiddenSessionsPath,
      JSON.stringify({ version: 1, sessions: state.sessions || {} }, null, 2),
      'utf8'
    );
  }

  async function readHiddenProjectsState() {
    try {
      const raw = await fs.readFile(hiddenProjectsPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        version: 1,
        projects: parsed && typeof parsed.projects === 'object' && !Array.isArray(parsed.projects)
          ? parsed.projects
          : {}
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[projects] Failed to read hidden project state:', error.message);
      }
      return emptyHiddenProjectsState();
    }
  }

  async function writeHiddenProjectsState(state) {
    await fs.mkdir(path.dirname(hiddenProjectsPath), { recursive: true });
    await fs.writeFile(
      hiddenProjectsPath,
      JSON.stringify({ version: 1, projects: state.projects || {} }, null, 2),
      'utf8'
    );
  }

  async function readHiddenSessionIds() {
    const state = await readHiddenSessionsState();
    return new Set(Object.keys(state.sessions || {}));
  }

  async function readHiddenProjectIds() {
    const state = await readHiddenProjectsState();
    return new Set(Object.keys(state.projects || {}));
  }

  async function readHiddenProjects() {
    const state = await readHiddenProjectsState();
    return Object.entries(state.projects || {})
      .map(([id, project]) => ({ id, ...project }))
      .sort((a, b) => new Date(b.hiddenAt || 0) - new Date(a.hiddenAt || 0));
  }

  async function hideSessionInMobile(session) {
    const id = String(session?.id || '').trim();
    if (!id) {
      const error = new Error('Session id is required');
      error.statusCode = 400;
      throw error;
    }

    const state = await readHiddenSessionsState();
    const existing = state.sessions[id];
    state.sessions[id] = {
      hiddenAt: existing?.hiddenAt || new Date().toISOString(),
      projectId: session.projectId || existing?.projectId || null,
      projectPath: session.cwd || existing?.projectPath || null,
      title: session.title || existing?.title || null
    };
    await writeHiddenSessionsState(state);
    return { sessionId: id, hiddenAt: state.sessions[id].hiddenAt };
  }

  async function hideProjectInMobile(project) {
    const id = String(project?.id || '').trim();
    if (!id) {
      const error = new Error('Project id is required');
      error.statusCode = 400;
      throw error;
    }

    const state = await readHiddenProjectsState();
    const existing = state.projects[id];
    state.projects[id] = {
      hiddenAt: existing?.hiddenAt || new Date().toISOString(),
      name: project.name || existing?.name || null,
      path: project.path || existing?.path || null,
      sessionCount: project.sessionCount ?? existing?.sessionCount ?? 0
    };
    await writeHiddenProjectsState(state);
    return { projectId: id, hiddenAt: state.projects[id].hiddenAt };
  }

  async function restoreProjectInMobile(projectId) {
    const id = String(projectId || '').trim();
    if (!id) {
      const error = new Error('Project id is required');
      error.statusCode = 400;
      throw error;
    }

    const state = await readHiddenProjectsState();
    const existing = state.projects[id] || null;
    if (!existing) {
      return { projectId: id, restored: false };
    }
    delete state.projects[id];
    await writeHiddenProjectsState(state);
    return { projectId: id, restored: true, project: { id, ...existing } };
  }

  async function readDeletedMessageIds(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) {
      return new Set();
    }
    const state = await readDeletedMessagesState();
    return new Set(Object.keys(state.sessions?.[id] || {}));
  }

  async function hideSessionMessage(sessionId, messageId) {
    const id = String(sessionId || '').trim();
    const itemId = String(messageId || '').trim();
    if (!id || !itemId) {
      const error = new Error('sessionId and messageId are required');
      error.statusCode = 400;
      throw error;
    }

    const state = await readDeletedMessagesState();
    if (!state.sessions[id] || typeof state.sessions[id] !== 'object' || Array.isArray(state.sessions[id])) {
      state.sessions[id] = {};
    }
    const existing = state.sessions[id][itemId];
    const deletedAt = existing?.deletedAt || new Date().toISOString();
    state.sessions[id][itemId] = { deletedAt };
    await writeDeletedMessagesState(state);
    return { sessionId: id, messageId: itemId, deletedAt };
  }

  return {
    hideSessionInMobile,
    hideProjectInMobile,
    hideSessionMessage,
    readDeletedMessageIds,
    readHiddenProjectIds,
    readHiddenProjects,
    readHiddenSessionIds,
    restoreProjectInMobile
  };
}

const defaultSessionLocalState = createSessionLocalState();

export const hideSessionInMobile = (...args) => defaultSessionLocalState.hideSessionInMobile(...args);
export const hideProjectInMobile = (...args) => defaultSessionLocalState.hideProjectInMobile(...args);
export const hideSessionMessageInLocalState = (...args) => defaultSessionLocalState.hideSessionMessage(...args);
export const readDeletedMessageIds = (...args) => defaultSessionLocalState.readDeletedMessageIds(...args);
export const readHiddenProjectIds = (...args) => defaultSessionLocalState.readHiddenProjectIds(...args);
export const readHiddenProjects = (...args) => defaultSessionLocalState.readHiddenProjects(...args);
export const readHiddenSessionIds = (...args) => defaultSessionLocalState.readHiddenSessionIds(...args);
export const restoreProjectInMobile = (...args) => defaultSessionLocalState.restoreProjectInMobile(...args);
