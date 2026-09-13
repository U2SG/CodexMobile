// /api/activity — day-by-day summary of session activity, derived from
// fileSessionIndex. Cheap to serve (just walks the existing in-memory
// index + aggregates), so the "近况" panel in the Drawer can mount
// lazily without precomputation.
//
// Response shape:
//   {
//     days: 7,
//     agent: 'all' | 'codex' | 'claude',
//     activity: {
//       days: [{ date, sessionCount, fileCount, projectCount, byAgent }],
//       totals: { sessions, files, projects, byAgent }
//     }
//   }
//
// "Days" here is the lookback window in days; the returned `days` array
// inside `activity` only includes dates that actually had touches, in
// most-recent-first order.

import { sendJson } from './http-utils.js';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 365;
const KNOWN_AGENTS = new Set(['codex', 'claude']);

function clampDays(raw) {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAYS;
  return Math.max(1, Math.min(MAX_DAYS, Math.floor(n)));
}

function normalizeAgent(raw) {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).trim().toLowerCase();
  if (!v || v === 'all') return null;
  return KNOWN_AGENTS.has(v) ? v : null;
}

export function createActivityRoutes({ fileSessionIndex } = {}) {
  if (!fileSessionIndex || typeof fileSessionIndex.aggregateActivity !== 'function') {
    throw new Error('createActivityRoutes: fileSessionIndex with aggregateActivity is required');
  }
  return async function handle(req, res, ctx) {
    const { method, pathname, url } = ctx;
    if (method !== 'GET' || pathname !== '/api/activity') return false;
    const days = clampDays(url.searchParams.get('days'));
    const agentFilter = normalizeAgent(url.searchParams.get('agent'));
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    try {
      const activity = await fileSessionIndex.aggregateActivity({ sinceMs, agentFilter });
      sendJson(res, 200, {
        days,
        agent: agentFilter || 'all',
        activity
      });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || 'activity aggregation failed' });
    }
    return true;
  };
}
