// Desktop bridge status + runtime prefs routes. Both are mobile-only
// affordances over the locally-running Codex desktop app:
//   GET   /api/desktop/status      — bridge probe + currently-open thread ids
//   GET   /api/runtime-prefs       — all KNOWN_PREF_KEYS values
//   PATCH /api/runtime-prefs       — partial update of any KNOWN_PREF_KEYS
//
// Conceptually codex-route-leaning (runtime prefs include ipcTurnsEnabled
// which is codex-desktop-IPC specific), but the routes themselves don't
// branch on agent — the runtimePrefs store accepts arbitrary KNOWN_PREF_KEYS
// regardless of which route is active.
//
// Extracted from server/index.js (Batch G R28).

import { readBody, sendJson } from './http-utils.js';

export function createDesktopRoutes({
  runtimePrefs,
  knownPrefKeys,
  bridgeStatus,
  threadTracker
}) {
  if (!runtimePrefs) throw new Error('createDesktopRoutes: runtimePrefs is required');
  if (!Array.isArray(knownPrefKeys)) throw new Error('createDesktopRoutes: knownPrefKeys array is required');
  if (!bridgeStatus) throw new Error('createDesktopRoutes: bridgeStatus is required');
  if (!threadTracker) throw new Error('createDesktopRoutes: threadTracker is required');

  return async function handle(req, res, ctx) {
    const { method, pathname, url } = ctx;

    if (method === 'GET' && pathname === '/api/runtime-prefs') {
      sendJson(res, 200, await runtimePrefs.getAll());
      return true;
    }

    if (method === 'PATCH' && pathname === '/api/runtime-prefs') {
      try {
        const body = await readBody(req);
        const updates = {};
        for (const key of knownPrefKeys) {
          if (Object.prototype.hasOwnProperty.call(body, key)) {
            updates[key] = await runtimePrefs.set(key, body[key]);
          }
        }
        sendJson(res, 200, { success: true, prefs: await runtimePrefs.getAll(), updated: updates });
      } catch (error) {
        sendJson(res, error.statusCode || 500, { error: error.message || 'Failed to update prefs' });
      }
      return true;
    }

    if (method === 'GET' && pathname === '/api/desktop/status') {
      const force = url.searchParams.get('force') === '1';
      const status = await bridgeStatus.getStatus({ force });
      sendJson(res, 200, { ...status, openThreadIds: threadTracker.getOpenThreadIds() });
      return true;
    }

    return false;
  };
}
