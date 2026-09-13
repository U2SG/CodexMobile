import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BASE_DIR = process.cwd();
const STATE_SUBPATH = path.join('.codexmobile', 'state', 'pinned-sessions.json');

function emptyState() {
  return { version: 1, pinned: {}, folders: [] };
}

function normalizeState(parsed) {
  const state = emptyState();
  if (parsed && typeof parsed.pinned === 'object' && !Array.isArray(parsed.pinned)) {
    for (const [id, value] of Object.entries(parsed.pinned)) {
      if (!id || !value || typeof value !== 'object') continue;
      state.pinned[id] = {
        pinnedAt: value.pinnedAt || new Date().toISOString(),
        projectPath: value.projectPath || null,
        folderId: value.folderId || null
      };
    }
  }
  if (Array.isArray(parsed?.folders)) {
    const seen = new Set();
    for (const folder of parsed.folders) {
      if (!folder?.id || seen.has(folder.id)) continue;
      seen.add(folder.id);
      state.folders.push({
        id: String(folder.id),
        name: String(folder.name || '收藏夹').slice(0, 32),
        collapsed: Boolean(folder.collapsed),
        createdAt: folder.createdAt || new Date().toISOString()
      });
    }
  }
  return state;
}

export function createPinStore(baseDir = DEFAULT_BASE_DIR) {
  const statePath = path.join(baseDir, STATE_SUBPATH);

  async function readState() {
    try {
      const raw = await fs.readFile(statePath, 'utf8');
      return normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      if (error instanceof SyntaxError) {
        console.warn('[pinned-sessions] Corrupt state file, ignoring:', error.message);
        return emptyState();
      }
      console.warn('[pinned-sessions] Failed to read state:', error.message);
      return emptyState();
    }
  }

  async function writeState(state) {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  async function readPinSnapshot() {
    const state = await readState();
    return {
      pinned: new Map(Object.entries(state.pinned)),
      folders: state.folders
    };
  }

  async function listPinFolders() {
    const state = await readState();
    return state.folders;
  }

  async function pinSession({ sessionId, projectPath, folderId = null }) {
    const id = String(sessionId || '').trim();
    if (!id) {
      const error = new Error('sessionId is required');
      error.statusCode = 400;
      throw error;
    }
    const state = await readState();
    if (folderId && !state.folders.some((folder) => folder.id === folderId)) {
      const error = new Error('Folder not found');
      error.statusCode = 404;
      throw error;
    }
    const existing = state.pinned[id];
    state.pinned[id] = {
      pinnedAt: existing?.pinnedAt || new Date().toISOString(),
      projectPath: projectPath || existing?.projectPath || null,
      folderId: folderId || null
    };
    await writeState(state);
    return state.pinned[id];
  }

  async function unpinSession(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return false;
    const state = await readState();
    if (!state.pinned[id]) return false;
    delete state.pinned[id];
    await writeState(state);
    return true;
  }

  async function movePinnedToFolder(sessionId, folderId) {
    const id = String(sessionId || '').trim();
    if (!id) {
      const error = new Error('sessionId is required');
      error.statusCode = 400;
      throw error;
    }
    const state = await readState();
    const entry = state.pinned[id];
    if (!entry) {
      const error = new Error('Session is not pinned');
      error.statusCode = 404;
      throw error;
    }
    if (folderId && !state.folders.some((folder) => folder.id === folderId)) {
      const error = new Error('Folder not found');
      error.statusCode = 404;
      throw error;
    }
    entry.folderId = folderId || null;
    await writeState(state);
    return entry;
  }

  async function createPinFolder(name) {
    const trimmed = String(name || '').trim().slice(0, 32);
    if (!trimmed) {
      const error = new Error('Folder name is required');
      error.statusCode = 400;
      throw error;
    }
    const state = await readState();
    const folder = {
      id: `f_${crypto.randomUUID().slice(0, 8)}`,
      name: trimmed,
      collapsed: false,
      createdAt: new Date().toISOString()
    };
    state.folders.push(folder);
    await writeState(state);
    return folder;
  }

  async function updatePinFolder(folderId, patch) {
    const state = await readState();
    const folder = state.folders.find((item) => item.id === folderId);
    if (!folder) {
      const error = new Error('Folder not found');
      error.statusCode = 404;
      throw error;
    }
    if (typeof patch?.name === 'string') {
      const trimmed = patch.name.trim().slice(0, 32);
      if (trimmed) folder.name = trimmed;
    }
    if (typeof patch?.collapsed === 'boolean') {
      folder.collapsed = patch.collapsed;
    }
    await writeState(state);
    return folder;
  }

  async function deletePinFolder(folderId) {
    const state = await readState();
    const index = state.folders.findIndex((item) => item.id === folderId);
    if (index < 0) return false;
    state.folders.splice(index, 1);
    for (const entry of Object.values(state.pinned)) {
      if (entry.folderId === folderId) entry.folderId = null;
    }
    await writeState(state);
    return true;
  }

  async function removePinForSession(sessionId) {
    return unpinSession(sessionId);
  }

  return {
    readPinSnapshot,
    listPinFolders,
    pinSession,
    unpinSession,
    movePinnedToFolder,
    createPinFolder,
    updatePinFolder,
    deletePinFolder,
    removePinForSession
  };
}

const defaultStore = createPinStore();

export const readPinSnapshot = (...args) => defaultStore.readPinSnapshot(...args);
export const listPinFolders = (...args) => defaultStore.listPinFolders(...args);
export const pinSession = (...args) => defaultStore.pinSession(...args);
export const unpinSession = (...args) => defaultStore.unpinSession(...args);
export const movePinnedToFolder = (...args) => defaultStore.movePinnedToFolder(...args);
export const createPinFolder = (...args) => defaultStore.createPinFolder(...args);
export const updatePinFolder = (...args) => defaultStore.updatePinFolder(...args);
export const deletePinFolder = (...args) => defaultStore.deletePinFolder(...args);
export const removePinForSession = (...args) => defaultStore.removePinForSession(...args);
