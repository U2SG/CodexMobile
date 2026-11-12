// Pending diff review comments survive closing the Git panel (it unmounts)
// for the rest of the browser session, per project. Storage can be missing
// or throw (private mode); then comments simply live in memory only.

const KEY_PREFIX = 'codexmobile.reviewComments.';

function defaultStorage() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

export function loadReviewComments(projectId, storage = defaultStorage()) {
  if (!projectId || !storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(KEY_PREFIX + projectId) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => item && item.id && item.body) : [];
  } catch {
    return [];
  }
}

export function saveReviewComments(projectId, comments, storage = defaultStorage()) {
  if (!projectId || !storage) return;
  try {
    if (comments.length) storage.setItem(KEY_PREFIX + projectId, JSON.stringify(comments));
    else storage.removeItem(KEY_PREFIX + projectId);
  } catch {
    // Quota or disabled storage: keep the in-memory list only.
  }
}
