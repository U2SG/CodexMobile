import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultProvider } from './agent-mode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT_DIR, '.codexmobile', 'state');
const INDEX_PATH = path.join(STATE_DIR, 'mobile-sessions.json');
// Raised from 300: the index now also carries title overrides for Claude
// terminal sessions (~220), so 300 would trim — and silently drop titles — as
// soon as a few new sessions arrive. 500 keeps them durable.
const MAX_SESSIONS = 500;

async function readIndexFile() {
  try {
    const raw = await fs.readFile(INDEX_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[mobile-sessions] Failed to read index:', error.message);
    }
    return [];
  }
}

async function writeIndexFile(sessions) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const trimmed = sessions
    .filter((session) => session?.id && session?.projectPath)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    .slice(0, MAX_SESSIONS);
  await fs.writeFile(
    INDEX_PATH,
    JSON.stringify({ version: 1, sessions: trimmed }, null, 2),
    'utf8'
  );
}

function fallbackTitle(title, summary) {
  const value = String(title || summary || '').trim();
  return value ? value.slice(0, 52) : '新对话';
}

export async function readMobileSessionIndex() {
  const sessions = await readIndexFile();
  return new Map(
    sessions
      .filter((session) => session?.id)
      .map((session) => [session.id, session])
  );
}

export async function readMobileSessions() {
  return readIndexFile();
}

export async function readMobileSessionMessages(sessionId) {
  const sessions = await readIndexFile();
  const session = sessions.find((item) => item.id === sessionId);
  return Array.isArray(session?.messages) ? session.messages : [];
}

export async function deleteMobileSession(sessionId) {
  return deleteMobileSessions([sessionId]);
}

export async function deleteMobileSessions(sessionIds) {
  const ids = new Set((Array.isArray(sessionIds) ? sessionIds : []).map((id) => String(id || '').trim()).filter(Boolean));
  if (!ids.size) {
    return false;
  }
  const sessions = await readIndexFile();
  const next = sessions.filter((session) => !ids.has(session.id));
  if (next.length === sessions.length) {
    return false;
  }
  await writeIndexFile(next);
  return true;
}

export async function registerMobileSession({ id, projectPath, title, summary, updatedAt, messages, model, provider, source }) {
  if (!id || !projectPath || String(id).startsWith('draft-') || String(id).startsWith('codex-')) {
    return null;
  }

  const now = updatedAt || new Date().toISOString();
  const sessions = await readIndexFile();
  const existingIndex = sessions.findIndex((session) => session.id === id);
  const existing = existingIndex >= 0 ? sessions[existingIndex] : null;
  const next = {
    ...(existing || {}),
    id,
    projectPath: path.resolve(projectPath),
    title: existing?.title || fallbackTitle(title, summary),
    titleLocked: Boolean(existing?.titleLocked),
    summary: summary || title || existing?.summary || 'CodexMobile 对话',
    updatedAt: now,
    model: model || existing?.model || null,
    // Stamp the registering server's agent so the other instance's drawer can
    // filter this record out — the state file is shared between the codex and
    // claude servers, and an unstamped record leaks into both session lists.
    provider: provider || existing?.provider || defaultProvider(),
    source: source || existing?.source || 'codexmobile'
  };
  if (Array.isArray(messages)) {
    const seenMessageIds = new Set();
    next.messages = messages
      .filter((message) => message && message.role && typeof message.content === 'string')
      .map((message) => ({
        id: String(message.id || `${id}-${Date.now()}`),
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
        timestamp: message.timestamp || now
      }))
      .filter((message) => {
        if (seenMessageIds.has(message.id)) {
          return false;
        }
        seenMessageIds.add(message.id);
        return true;
      });
  }

  if (existingIndex >= 0) {
    sessions[existingIndex] = next;
  } else {
    sessions.push(next);
  }
  await writeIndexFile(sessions);
  return next;
}

export async function renameMobileSession({ id, projectPath, title, updatedAt }) {
  const sessionId = String(id || '').trim();
  if (!sessionId || !projectPath || sessionId.startsWith('draft-')) {
    return null;
  }

  const sessions = await readIndexFile();
  const existingIndex = sessions.findIndex((session) => session.id === sessionId);
  const existing = existingIndex >= 0 ? sessions[existingIndex] : null;
  const next = {
    ...(existing || {}),
    id: sessionId,
    projectPath: path.resolve(projectPath),
    title: fallbackTitle(title),
    titleLocked: true,
    summary: existing?.summary,
    updatedAt: existing?.updatedAt || updatedAt || new Date().toISOString(),
    provider: existing?.provider || defaultProvider(),
    source: existing?.source || 'codexmobile'
  };

  if (existingIndex >= 0) {
    sessions[existingIndex] = next;
  } else {
    sessions.push(next);
  }
  await writeIndexFile(sessions);
  return next;
}
