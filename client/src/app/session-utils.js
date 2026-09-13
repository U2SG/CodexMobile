// Session-level utility helpers shared across App.jsx and the app/* hooks.
// Pulled out so the hooks don't have to receive these as dependencies — each
// is a pure function with no React or App-state coupling.
//
// Extracted in Stage 2 R8 from App.jsx top-level definitions, extended by
// Batch C5 with file-preview path helpers and the theme storage key.

// LocalStorage key for the user's theme preference ('light' / 'dark' / 'system').
// Lives here so FilePreviewApp.jsx can read it without circular-importing
// App.jsx.
export const THEME_KEY = 'codexmobile.theme';

export function createClientTurnId() {
  return globalThis.crypto?.randomUUID?.() || `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createDraftSession(project) {
  const now = new Date().toISOString();
  return {
    id: `draft-${project.id}-${Date.now()}`,
    projectId: project.id,
    title: '新对话',
    summary: '等待第一条消息',
    messageCount: 0,
    updatedAt: now,
    draft: true
  };
}

export function isDraftSession(session) {
  const id = typeof session === 'string' ? session : session?.id;
  return Boolean(session?.draft || id?.startsWith('draft-'));
}

export function titleFromFirstMessage(message) {
  const value = String(message || '').trim().replace(/\s+/g, ' ');
  return value ? value.slice(0, 52) : '新对话';
}

// Insert / replace a session inside the per-project sessionsByProject map.
// `replaceId` lets callers swap an optimistic draft id for the real server
// id without leaving a stale entry behind. Returns a new top-level object
// when projectId+session are valid; otherwise returns `current` unchanged.
export function upsertSessionInProject(current, projectId, session, replaceId = null) {
  if (!projectId || !session) {
    return current;
  }
  const existing = current[projectId] || [];
  const filtered = existing.filter((item) => item.id !== session.id && (!replaceId || item.id !== replaceId));
  return {
    ...current,
    [projectId]: [session, ...filtered]
  };
}

// Shorten a long absolute path to "parent/name" for in-chrome display where
// the full path doesn't fit (e.g. file preview subtitle). Falls through for
// short paths without dropping anything.
export function compactPath(value) {
  if (!value) {
    return '';
  }
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 2 ? `${parts.at(-2)}/${parts.at(-1)}` : normalized;
}

// decodeURIComponent that returns the input verbatim on malformed input —
// avoids a "URI malformed" throw deep inside an unrelated helper when the
// server hands us a path that was already once-decoded.
export function safeDecodeUriComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Build a /api/local-image URL for a server-local image path. Used by the
// chat-side attachment preview (R4 attachment-preview helpers) and the file
// preview shell when rendering inline images.
export function localImageApiPath(value) {
  const raw = String(value || '').trim();
  const normalized = /%[0-9a-f]{2}/i.test(raw) ? safeDecodeUriComponent(raw) : raw;
  return `/api/local-image?path=${encodeURIComponent(normalized)}`;
}

// Build a /api/local-file URL. When token is provided, append it so the
// request can carry auth even when the caller is a tag-based fetch (e.g.
// the <a target="_blank"> "open original" link in file preview) that can't
// add an Authorization header.
export function localFileApiPath(value, token = '') {
  const raw = String(value || '').trim();
  const normalized = /%[0-9a-f]{2}/i.test(raw) ? safeDecodeUriComponent(raw) : raw;
  const tokenValue = String(token || '').trim();
  const tokenParam = tokenValue ? `&token=${encodeURIComponent(tokenValue)}` : '';
  return `/api/local-file?path=${encodeURIComponent(normalized)}${tokenParam}`;
}

// Build a /preview/file SPA route URL — main.jsx pathname-switches to
// FilePreviewApp when this route is opened in a new tab.
export function localFilePreviewPath(value, token = '') {
  const raw = String(value || '').trim();
  const normalized = /%[0-9a-f]{2}/i.test(raw) ? safeDecodeUriComponent(raw) : raw;
  const params = new URLSearchParams();
  params.set('path', normalized);
  const tokenValue = String(token || '').trim();
  if (tokenValue) {
    params.set('token', tokenValue);
  }
  return `/preview/file?${params.toString()}`;
}

// Every history load goes through here so all call sites agree on what a
// message list contains. `includeActivity` pulls the collapsed step layer
// (commands, file changes, turn narration) for past turns — without it the
// timeline only ever appears on turns that streamed live in this session.
export function sessionMessagesPath(sessionId, { limit = 120, includeActivity = true } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (includeActivity) {
    params.set('includeActivity', '1');
  }
  return `/api/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`;
}
