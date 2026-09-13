// Full-text session search. Walks rollouts under both agent session dirs
// (same set as file-session-index) within a recent mtime window, scans
// each line for a literal substring (case-insensitive), and returns hits
// tagged with sessionId, agent, cwd, timestamp + a short snippet.
//
// Intentionally simple — no inverted index, no regex, no JSON-shape
// awareness. The substring may match inside JSON wrapping or raw text;
// the caller renders the snippet in a monospace box so it's clear that
// what they see is a raw rollout fragment, not parsed message content.
// Bounded by file mtime + per-session cap + total result cap so a 90-day
// corpus stays under ~5s.
//
// CAVEAT — JSON-escape blindness: the match is byte-level over the raw
// rollout text. Inside a JSON string, a literal `"` is stored as `\"` and
// a newline as `\n`, so a query containing actual quotes or newlines
// (e.g. `say "hello"`) won't match — the file holds `say \"hello\"`.
// Search for unquoted fragments (file paths, function names, words from
// inside the prose) and you're fine. If this becomes a real complaint,
// strip backslash-escapes from the query before scanning.

import { sendJson } from './http-utils.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
// Match file-session-index's CODEXMOBILE_FILE_SESSION_INDEX_DAYS default
// of 90 — same corpus, same intuition about what "recent enough to surface"
// means. Diverging would cause "I see a badge but search doesn't find it"
// surprises.
const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;
const MAX_PER_SESSION = 3;
const MAX_FILE_BYTES = 16 * 1024 * 1024; // skip very large rollouts
const SNIPPET_RADIUS = 80;

function clamp(rawValue, min, max, fallback) {
  // url.searchParams.get returns null when the param is absent. Treat
  // null / undefined / empty-string as "use the default" — coercing null
  // to 0 would otherwise floor every default to `min`.
  if (rawValue === null || rawValue === undefined || rawValue === '') return fallback;
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function extractSnippet(line, queryLower) {
  const lineLower = String(line || '').toLowerCase();
  const idx = lineLower.indexOf(queryLower);
  if (idx < 0) return '';
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(line.length, idx + queryLower.length + SNIPPET_RADIUS);
  let snippet = line.slice(start, end).trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < line.length) snippet = `${snippet}…`;
  // Strip control chars so the snippet doesn't smuggle ANSI escapes
  // into the JSON response.
  return snippet.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
}

// Walk a single rollout's lines once, tracking the session header
// (codex emits a session_meta; claude carries sessionId/cwd at the
// envelope top level), and yield hits as we find them. The per-session
// cap is enforced here so one chatty session can't flood the results.
export function scanRolloutLines(text, queryLower, { maxPerSession = MAX_PER_SESSION } = {}) {
  let sessionId = null;
  let cwd = null;
  let sessionTimestamp = null;
  const hits = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    if (!rawLine) continue;
    // Header detection — try to pull session metadata before we
    // accumulate hits so each hit knows which session it belongs to.
    if (!sessionId || !cwd) {
      try {
        const entry = JSON.parse(rawLine);
        if (entry?.type === 'session_meta' && entry.payload) {
          sessionId = entry.payload.id || sessionId;
          cwd = entry.payload.cwd || cwd;
          sessionTimestamp = entry.timestamp || sessionTimestamp;
        } else if (typeof entry?.sessionId === 'string' && !sessionId) {
          sessionId = entry.sessionId;
          if (typeof entry.cwd === 'string') cwd = cwd || entry.cwd;
          if (typeof entry.timestamp === 'string') sessionTimestamp = sessionTimestamp || entry.timestamp;
        }
      } catch {
        // line wasn't JSON — fine, just skip header extraction for it
      }
    }
    const lineLower = rawLine.toLowerCase();
    if (!lineLower.includes(queryLower)) continue;
    if (hits.length >= maxPerSession) break;
    // Try to pull a per-event timestamp; fall back to session start.
    let matchedAt = null;
    try {
      const entry = JSON.parse(rawLine);
      if (typeof entry?.timestamp === 'string') matchedAt = entry.timestamp;
    } catch { /* keep matchedAt null */ }
    hits.push({
      snippet: extractSnippet(rawLine, queryLower),
      matchedAt: matchedAt || sessionTimestamp || null
    });
  }
  return { sessionId, cwd, hits };
}

const KNOWN_AGENTS = new Set(['codex', 'claude']);

function normalizeAgentFilter(raw) {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).trim().toLowerCase();
  if (!v || v === 'all') return null;
  return KNOWN_AGENTS.has(v) ? v : null;
}

function normalizeProjectPath(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  return raw.replace(/\\/g, '/').toLowerCase();
}

export function createSearchRoutes({
  listRolloutFiles,
  readRolloutFile,
  classifySourceFile = null,
  // Optional: resolves a projectId hash into the project's cwd so the
  // route can scope hits to "this project only". Mirrors how
  // file-session-routes uses getProject.
  getProject = null
} = {}) {
  if (typeof listRolloutFiles !== 'function') {
    throw new Error('createSearchRoutes: listRolloutFiles is required');
  }
  if (typeof readRolloutFile !== 'function') {
    throw new Error('createSearchRoutes: readRolloutFile is required');
  }

  return async function handle(req, res, ctx) {
    const { method, pathname, url } = ctx;
    if (method !== 'GET' || pathname !== '/api/search') return false;

    const rawQuery = url.searchParams.get('q');
    const query = String(rawQuery || '').trim();
    if (!query) {
      sendJson(res, 400, { error: 'q is required' });
      return true;
    }
    // Cap query length so a 1MB substring search doesn't gobble the loop.
    if (query.length > 256) {
      sendJson(res, 400, { error: 'q too long (max 256 chars)' });
      return true;
    }

    const limit = clamp(url.searchParams.get('limit'), 1, MAX_LIMIT, DEFAULT_LIMIT);
    const days = clamp(url.searchParams.get('days'), 1, MAX_DAYS, DEFAULT_DAYS);
    // `since=YYYY-MM-DD` (or any Date.parse-able string) overrides `days`
    // when provided — useful for "search across the whole year" without
    // calling `days=365`.
    const sinceRaw = url.searchParams.get('since');
    let cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    if (sinceRaw) {
      const sinceMs = Date.parse(sinceRaw);
      if (Number.isFinite(sinceMs)) cutoffMs = sinceMs;
    }
    const agentFilter = normalizeAgentFilter(url.searchParams.get('agent'));
    const projectIdFilter = url.searchParams.get('projectId') || null;
    let projectCwdLower = '';
    if (projectIdFilter) {
      if (typeof getProject !== 'function') {
        sendJson(res, 400, { error: 'projectId filter not supported on this route' });
        return true;
      }
      const project = getProject(projectIdFilter);
      if (!project || !project.path) {
        sendJson(res, 404, { error: 'Project not found' });
        return true;
      }
      projectCwdLower = normalizeProjectPath(project.path);
    }
    const queryLower = query.toLowerCase();

    try {
      const allFiles = await listRolloutFiles();
      // listRolloutFiles may already mtime-filter; redo here so the
      // search route is independent of how it was configured.
      const files = allFiles.filter((f) => {
        const mt = typeof f === 'object' ? Number(f?.mtimeMs || 0) : 0;
        return !mt || mt >= cutoffMs;
      });

      const out = [];
      for (const fileEntry of files) {
        if (out.length >= limit) break;
        const filePath = typeof fileEntry === 'string' ? fileEntry : fileEntry?.path;
        if (!filePath) continue;
        // Skip the whole file early when the agent filter rules it out —
        // no point reading a codex rollout when the user is filtering to
        // claude only.
        const agent = classifySourceFile ? classifySourceFile(filePath) : undefined;
        if (agentFilter && agent !== agentFilter) continue;
        let text;
        try {
          text = await readRolloutFile(filePath);
        } catch {
          continue;
        }
        if (typeof text !== 'string' || text.length > MAX_FILE_BYTES) continue;
        // Cheap pre-filter — most files won't contain the query.
        if (!text.toLowerCase().includes(queryLower)) continue;
        const result = scanRolloutLines(text, queryLower);
        if (!result.sessionId || result.hits.length === 0) continue;
        // Project filter: compare the session's cwd (collapsed slashes,
        // lower-cased) against the project's path. Skip whole sessions
        // outside the requested project.
        if (projectCwdLower) {
          const sessionCwdLower = normalizeProjectPath(result.cwd || '');
          if (sessionCwdLower !== projectCwdLower) continue;
        }
        for (const hit of result.hits) {
          if (out.length >= limit) break;
          out.push({
            sessionId: result.sessionId,
            agent,
            cwd: result.cwd,
            snippet: hit.snippet,
            matchedAt: hit.matchedAt
          });
        }
      }

      // Most-recent hits first when we have timestamps; fall back to
      // discovery order when timestamps are missing.
      out.sort((a, b) => {
        const ta = a.matchedAt ? Date.parse(a.matchedAt) || 0 : 0;
        const tb = b.matchedAt ? Date.parse(b.matchedAt) || 0 : 0;
        return tb - ta;
      });

      sendJson(res, 200, {
        query,
        days,
        limit,
        agentFilter: agentFilter || 'all',
        projectId: projectIdFilter || null,
        since: sinceRaw || null,
        results: out
      });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || 'search failed' });
    }
    return true;
  };
}
