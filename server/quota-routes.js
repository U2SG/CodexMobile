// Codex quota query + account switch routes. Codex-only endpoints — the
// Claude route has no equivalent (quota lives inside Claude Code CLI, not
// surfaced to the mobile client). Extracted from server/index.js (Batch G
// R25).
//
// Inputs (factory):
//   getCodexQuota       — from ./codex-quota.js
//   switchCodexAccount  — from ./codex-quota.js
//   remoteAddress       — from ./http-utils.js (for log lines)
//
// Returns: async handle(req, res, ctx) → true if the route matched,
// false otherwise. ctx = { method, pathname }.

import { readBody, sendJson } from './http-utils.js';

export function createQuotaRoutes({ getCodexQuota, switchCodexAccount, remoteAddress }) {
  if (typeof getCodexQuota !== 'function') throw new Error('createQuotaRoutes: getCodexQuota is required');
  if (typeof switchCodexAccount !== 'function') throw new Error('createQuotaRoutes: switchCodexAccount is required');
  if (typeof remoteAddress !== 'function') throw new Error('createQuotaRoutes: remoteAddress is required');

  return async function handle(req, res, ctx) {
    const { method, pathname } = ctx;

    if (method === 'GET' && pathname === '/api/quotas/codex') {
      try {
        sendJson(res, 200, await getCodexQuota());
      } catch (error) {
        console.warn(`[quota] codex quota failed remote=${remoteAddress(req)} message=${error.message || 'unknown'}`);
        sendJson(res, 500, { error: 'Failed to query Codex quota' });
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/quotas/codex/switch') {
      try {
        const body = await readBody(req);
        const result = await switchCodexAccount(body.accountId || body.id || body.name);
        sendJson(res, 200, { success: true, ...result });
      } catch (error) {
        const statusCode = error.statusCode || 500;
        console.warn(`[quota] codex switch failed remote=${remoteAddress(req)} message=${error.message || 'unknown'}`);
        sendJson(res, statusCode, { error: error.message || 'Failed to switch Codex account' });
      }
      return true;
    }

    return false;
  };
}
