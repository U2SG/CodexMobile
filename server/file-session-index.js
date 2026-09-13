// file ↔ session index — answers "which recent sessions edited this file?"
//
// Scope (slice 1+2, 阶段 C):
//   - Codex rollouts (~/.codex/sessions/**/*.jsonl): custom_tool_call
//     entries with name=apply_patch. We parse the patch body for
//     `*** Add File:`, `*** Update File:`, `*** Delete File:` markers.
//   - Claude rollouts (~/.claude/projects/**/*.jsonl): assistant entries
//     whose message.content contains a tool_use whose name is one of
//     Write / Edit / MultiEdit / NotebookEdit. Both sources funnel into
//     the same {sessionId, absPath, touchedAt} triple — the index doesn't
//     care which agent produced the touch.
//   - Shell-based writes (Set-Content / Out-File / cp / mv / Bash with
//     redirects) are intentionally NOT tracked from either source —
//     they're noisy and would surface every `cat file | grep ...` as a
//     "session that touched file".
//
// Build strategy: lazy + memoized + persistent. First request triggers the
// scan; subsequent requests hit the cache until invalidate() is called
// (wired to the `sync-complete` broadcast in server/index.js). Per-file
// parsed state is persisted to `.codexmobile/file-session-index.json` so
// the next server restart only re-reads files whose mtime changed.
//
// Path normalization: absolute paths only, run through
// session-index-builder.normalizeComparablePath so Windows D:\ vs d:\ and
// mixed slashes collapse to one key. Routes resolve callers' relative
// paths against the project's cwd before lookup.

import path from 'node:path';
import { normalizeComparablePath } from './session-index-builder.js';

const PERSISTENCE_VERSION = 1;
const APPLY_PATCH_HEADER_RE = /^\*\*\* (Add|Update|Delete) File:\s+(.+?)\s*$/;
const WIN_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

// Cross-OS aware join: detect Windows-style absolute paths (drive letter)
// regardless of the host process's platform. Necessary because claude
// rollouts emit Windows-style `cwd` and `file_path` strings even on
// Linux hosts indexing them, and path.resolve on POSIX would treat
// "D:\foo" as relative and prepend process.cwd.
function joinAbsPath(cwd, relPath) {
  if (WIN_ABSOLUTE_RE.test(relPath)) return path.win32.normalize(relPath);
  if (WIN_ABSOLUTE_RE.test(cwd)) return path.win32.resolve(cwd, relPath);
  return path.resolve(cwd, relPath);
}

// Index key derivation, also cross-OS aware. POSIX-host indexing a
// Windows-style path is preserved verbatim (lowercased) so a query for
// the same path produces the same key.
function indexKey(absPath) {
  if (typeof absPath !== 'string' || !absPath) return '';
  if (WIN_ABSOLUTE_RE.test(absPath)) return path.win32.normalize(absPath).toLowerCase();
  return normalizeComparablePath(absPath);
}

function parsePatchOps(input) {
  if (typeof input !== 'string' || !input.includes('*** ')) return [];
  const ops = [];
  for (const raw of input.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const match = APPLY_PATCH_HEADER_RE.exec(line);
    if (!match) continue;
    const op = match[1].toLowerCase(); // 'add' | 'update' | 'delete'
    const relPath = match[2];
    if (!relPath) continue;
    ops.push({ op, relPath });
  }
  return ops;
}

export function parseCodexRolloutForFileTouches(text) {
  // Single-pass parse: pull session_meta (id, cwd) and any apply_patch ops.
  // Tolerant of partial / corrupted lines — broken JSON is skipped.
  let sessionId = null;
  let cwd = null;
  let sessionTimestamp = null;
  const touches = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    if (!rawLine) continue;
    let entry;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const payload = entry.payload;
    if (!payload || typeof payload !== 'object') continue;
    if (entry.type === 'session_meta') {
      sessionId = payload.id || sessionId;
      cwd = payload.cwd || cwd;
      sessionTimestamp = entry.timestamp || sessionTimestamp;
      continue;
    }
    if (entry.type !== 'response_item') continue;
    if (payload.type !== 'custom_tool_call') continue;
    if (payload.name !== 'apply_patch') continue;
    const tsMs = Date.parse(entry.timestamp || '') || null;
    for (const { op, relPath } of parsePatchOps(payload.input || '')) {
      touches.push({ op, relPath, touchedAt: tsMs });
    }
  }
  return { sessionId, cwd, sessionTimestamp, touches };
}

// Claude Code "write" tools — every tool_use of these names attaches an
// absolute file_path (or notebook_path) in `input`. Other names like Read
// or Glob are read-only and skipped.
const CLAUDE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Approximation: claude doesn't tell us whether the file existed before
// this tool call. Write CAN be either add-or-update (it overwrites);
// Edit/MultiEdit REQUIRE the file to exist already. The codex apply_patch
// parser distinguishes Add/Update/Delete precisely, so the badge UI
// renders the right color *most* of the time. If the reverse-direction
// UI (slice 3) ever needs "which session created this file", revisit.
function claudeOpFor(toolName) {
  if (toolName === 'Write') return 'add';
  return 'update';
}

export function parseClaudeRolloutForFileTouches(text) {
  // Claude format: each line is a flat JSON envelope carrying its own
  // sessionId, cwd, timestamp + a `message` object whose `content` is an
  // array of items. Tool calls are items with `type: 'tool_use'`. Unlike
  // codex's apply_patch, claude's write tools attach their target path
  // directly in `input.file_path` (already absolute on disk).
  let sessionId = null;
  let cwd = null;
  let sessionTimestamp = null;
  const touches = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    if (!rawLine) continue;
    let entry;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.sessionId === 'string' && !sessionId) sessionId = entry.sessionId;
    if (typeof entry.cwd === 'string' && !cwd) cwd = entry.cwd;
    if (typeof entry.timestamp === 'string' && !sessionTimestamp) sessionTimestamp = entry.timestamp;
    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    const tsMs = Date.parse(entry.timestamp || '') || null;
    for (const item of content) {
      if (!item || item.type !== 'tool_use') continue;
      if (!CLAUDE_WRITE_TOOLS.has(item.name)) continue;
      const filePath = item.input?.file_path || item.input?.notebook_path;
      if (typeof filePath !== 'string' || !filePath) continue;
      touches.push({ op: claudeOpFor(item.name), relPath: filePath, touchedAt: tsMs });
    }
  }
  return { sessionId, cwd, sessionTimestamp, touches };
}

export function parseRolloutForFileTouches(text) {
  // Dispatch by first useful line. Codex rollouts open with
  //   {"timestamp":"…","type":"session_meta",…}
  // Claude rollouts open with permission-mode / file-history-snapshot
  // entries and carry sessionId/cwd at the envelope's top level on
  // every assistant turn. Sniff the first non-empty line; fall back to
  // the codex parser when the sniff is ambiguous (cheap if it returns
  // nothing useful — caller still gets a valid empty result).
  const sample = String(text || '').slice(0, 2048);
  if (sample.includes('"type":"session_meta"')) {
    return parseCodexRolloutForFileTouches(text);
  }
  if (sample.includes('"permissionMode"') || sample.includes('"file-history-snapshot"') || sample.includes('"sessionId"')) {
    return parseClaudeRolloutForFileTouches(text);
  }
  return parseCodexRolloutForFileTouches(text);
}

export function createFileSessionIndex({
  listRolloutFiles,
  readRolloutFile,
  loadPersistence = async () => null,
  savePersistence = async () => {},
  // Optional: classifies a source rollout filePath into an agent string
  // ('codex' | 'claude' | other-string). The result is stamped on every
  // record so the client can render agent badges or route deep links to
  // the right peer server without a second roundtrip. When omitted,
  // records still build correctly but `agent` is undefined.
  classifySourceFile = null
} = {}) {
  if (typeof listRolloutFiles !== 'function') {
    throw new Error('createFileSessionIndex: listRolloutFiles is required');
  }
  if (typeof readRolloutFile !== 'function') {
    throw new Error('createFileSessionIndex: readRolloutFile is required');
  }

  let cache = null;
  let inflight = null;
  // Per-file parsed state. Survives invalidate() so re-scans after
  // sync-complete only re-read files whose mtime changed. Hydrated from
  // disk on first build via loadPersistence().
  let fileStates = null; // null = not loaded; otherwise Map<path, {mtimeMs, parsed|null}>

  // Cap concurrent file reads. Sequential reads on the codex sessions
  // tree were measured at ~14s for 389 rollouts on Windows + warm cache;
  // a small parallel pool brings that under 2s. Cap so we don't blow the
  // FD table on enormous corpora.
  const READ_CONCURRENCY = 16;

  async function readBatched(files) {
    const results = [];
    let cursor = 0;
    async function worker() {
      while (cursor < files.length) {
        const idx = cursor;
        cursor += 1;
        const file = files[idx];
        try {
          results[idx] = await readRolloutFile(file);
        } catch {
          results[idx] = null;
        }
      }
    }
    const workers = Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  async function hydrateFileStates() {
    if (fileStates !== null) return;
    fileStates = new Map();
    let loaded;
    try {
      loaded = await loadPersistence();
    } catch (err) {
      console.warn('[file-session-index] persistence load failed:', err?.message || err);
      return;
    }
    if (!loaded || typeof loaded !== 'object') return;
    if (loaded.version !== PERSISTENCE_VERSION) return;
    const persisted = loaded.fileStates;
    if (!persisted || typeof persisted !== 'object') return;
    for (const [filePath, state] of Object.entries(persisted)) {
      if (!state || typeof state.mtimeMs !== 'number') continue;
      fileStates.set(filePath, {
        mtimeMs: state.mtimeMs,
        parsed: state.parsed && state.parsed.sessionId ? state.parsed : null
      });
    }
  }

  function fileStatesToJson() {
    const out = {};
    for (const [filePath, state] of fileStates.entries()) {
      out[filePath] = state;
    }
    return { version: PERSISTENCE_VERSION, builtAt: Date.now(), fileStates: out };
  }

  function aggregateEntries() {
    // entries: Map<normalizedAbsPath, Array<{ sessionId, absPath, touchedAt, op, cwd, sourceFile }>>
    const entries = new Map();
    for (const [filePath, state] of fileStates.entries()) {
      const parsed = state.parsed;
      if (!parsed || !parsed.sessionId || !parsed.cwd || !Array.isArray(parsed.touches)) continue;
      for (const touch of parsed.touches) {
        const absPath = joinAbsPath(parsed.cwd, touch.relPath);
        const key = indexKey(absPath);
        if (!key) continue;
        const record = {
          sessionId: parsed.sessionId,
          absPath,
          relPath: touch.relPath,
          touchedAt: touch.touchedAt || Date.parse(parsed.sessionTimestamp || '') || 0,
          op: touch.op,
          cwd: parsed.cwd,
          sourceFile: filePath,
          agent: classifySourceFile ? classifySourceFile(filePath) : undefined
        };
        const list = entries.get(key);
        if (list) {
          list.push(record);
        } else {
          entries.set(key, [record]);
        }
      }
    }
    return entries;
  }

  async function build() {
    const t0 = Date.now();
    await hydrateFileStates();
    // listRolloutFiles returns Array<{path, mtimeMs}>. Old callers that
    // pass plain strings still work — we coerce.
    const rawFiles = await listRolloutFiles();
    const files = rawFiles.map((entry) =>
      typeof entry === 'string' ? { path: entry, mtimeMs: 0 } : entry
    );
    const seenPaths = new Set();
    const filesToRead = [];
    let reused = 0;
    for (const file of files) {
      seenPaths.add(file.path);
      const prev = fileStates.get(file.path);
      if (prev && prev.mtimeMs === file.mtimeMs) {
        reused += 1;
        continue;
      }
      filesToRead.push(file);
    }
    // Drop entries for files that no longer exist.
    let dropped = 0;
    for (const cachedPath of [...fileStates.keys()]) {
      if (!seenPaths.has(cachedPath)) {
        fileStates.delete(cachedPath);
        dropped += 1;
      }
    }
    // Read + parse only the changed/new files.
    const texts = await readBatched(filesToRead.map((f) => f.path));
    let skippedNoPatch = 0;
    for (let i = 0; i < filesToRead.length; i += 1) {
      const file = filesToRead[i];
      const text = texts[i];
      let parsed = null;
      if (text != null) {
        // Cheap pre-filter — most codex rollouts don't apply_patch at all
        // and we can skip the per-line JSON.parse. Claude rollouts use
        // tool_use envelopes; check that marker too. If neither is
        // present, the file has no file-touch signal worth parsing.
        const hasTouchMarker =
          text.indexOf('apply_patch') !== -1 || text.indexOf('"tool_use"') !== -1;
        if (hasTouchMarker) {
          parsed = parseRolloutForFileTouches(text);
          if (!parsed.sessionId || !parsed.cwd || !parsed.touches.length) {
            parsed = null;
          }
        } else {
          skippedNoPatch += 1;
        }
      }
      fileStates.set(file.path, { mtimeMs: file.mtimeMs, parsed });
    }
    const entries = aggregateEntries();
    const builtAt = Date.now();
    const elapsed = builtAt - t0;
    console.log(
      `[file-session-index] build: ${files.length} files (${reused} reused, ${filesToRead.length} re-read, ${dropped} dropped, ${skippedNoPatch} fast-skipped), ${entries.size} unique paths, ${elapsed}ms`
    );
    // Persist asynchronously — failure is non-fatal; next build just
    // can't reuse this generation's results.
    const snapshot = fileStatesToJson();
    savePersistence(snapshot).catch((err) => {
      console.warn('[file-session-index] persistence save failed:', err?.message || err);
    });
    return { entries, builtAt, fileCount: files.length, buildMs: elapsed, reused, reread: filesToRead.length };
  }

  function prewarm() {
    // Fire-and-forget the build so the first user request hits a warm
    // cache instead of waiting through the cold scan. Errors are logged
    // by build() itself; we don't want startup to crash on a flaky FS.
    ensureBuilt().catch((err) => {
      console.warn('[file-session-index] prewarm failed:', err?.message || err);
    });
  }

  async function ensureBuilt() {
    if (cache) return cache;
    if (inflight) return inflight;
    inflight = build()
      .then((next) => {
        cache = next;
        return next;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  async function getSessionsForFile(absPath, { limit = 5 } = {}) {
    const data = await ensureBuilt();
    const key = indexKey(absPath);
    if (!key) return [];
    const hits = data.entries.get(key);
    if (!hits || hits.length === 0) return [];
    // Most-recent first. De-dupe by sessionId — a session can touch the
    // same file many times; the badge UI only needs to point at the session.
    const seen = new Set();
    const sorted = [...hits].sort((a, b) => (b.touchedAt || 0) - (a.touchedAt || 0));
    const out = [];
    for (const record of sorted) {
      if (seen.has(record.sessionId)) continue;
      seen.add(record.sessionId);
      out.push({
        sessionId: record.sessionId,
        touchedAt: record.touchedAt,
        op: record.op,
        cwd: record.cwd,
        agent: record.agent
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async function getFilesForSession(sessionId, { limit = 200 } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) return { files: [], cwd: null };
    await ensureBuilt();
    // Reverse direction: walk all fileStates and collect touches whose
    // session matches. O(file_count) but file_count is in the hundreds —
    // cheap at query time vs. maintaining a second reverse index.
    const seenPaths = new Set();
    const files = [];
    let cwd = null;
    for (const state of fileStates.values()) {
      const parsed = state.parsed;
      if (!parsed || parsed.sessionId !== sessionId) continue;
      if (!cwd) cwd = parsed.cwd;
      for (const touch of parsed.touches) {
        const absPath = joinAbsPath(parsed.cwd, touch.relPath);
        const key = indexKey(absPath);
        if (seenPaths.has(key)) continue;
        seenPaths.add(key);
        files.push({
          path: absPath,
          op: touch.op,
          touchedAt: touch.touchedAt || Date.parse(parsed.sessionTimestamp || '') || 0
        });
        if (files.length >= limit) break;
      }
      if (files.length >= limit) break;
    }
    files.sort((a, b) => (b.touchedAt || 0) - (a.touchedAt || 0));
    return { files, cwd };
  }

  async function aggregateActivity({ sinceMs = 0, agentFilter = null } = {}) {
    // Walks every parsed touch in the index, buckets by UTC date
    // (YYYY-MM-DD), and counts unique sessions / paths / projects per
    // day. Cheap because file-session-index already keeps every touch
    // in memory — this is just an aggregation pass.
    await ensureBuilt();
    const byDate = new Map(); // date → { sessions:Set, files:Set(key), projects:Set, byAgent:Map }
    const totals = {
      sessions: new Set(),
      files: new Set(),
      projects: new Set(),
      byAgent: new Map()
    };

    function bumpAgent(agentMap, agent, type, value) {
      if (!agent) return;
      let slot = agentMap.get(agent);
      if (!slot) {
        slot = { sessions: new Set(), files: new Set() };
        agentMap.set(agent, slot);
      }
      slot[type].add(value);
    }

    // Need filePath to classify each record's agent — iterate entries.
    for (const [filePath, state] of fileStates.entries()) {
      const parsed = state.parsed;
      if (!parsed || !parsed.sessionId || !parsed.cwd || !Array.isArray(parsed.touches)) continue;
      const agent = classifySourceFile ? classifySourceFile(filePath) : undefined;
      if (agentFilter && agent !== agentFilter) continue;
      const projectKey = indexKey(parsed.cwd);
      for (const touch of parsed.touches) {
        const tsMs = touch.touchedAt || Date.parse(parsed.sessionTimestamp || '') || 0;
        if (sinceMs && tsMs < sinceMs) continue;
        if (!tsMs) continue;
        const date = new Date(tsMs).toISOString().slice(0, 10);
        const fileKey = indexKey(joinAbsPath(parsed.cwd, touch.relPath));
        let bucket = byDate.get(date);
        if (!bucket) {
          bucket = {
            sessions: new Set(),
            files: new Set(),
            projects: new Set(),
            byAgent: new Map()
          };
          byDate.set(date, bucket);
        }
        bucket.sessions.add(parsed.sessionId);
        bucket.files.add(fileKey);
        if (projectKey) bucket.projects.add(projectKey);
        bumpAgent(bucket.byAgent, agent, 'sessions', parsed.sessionId);
        bumpAgent(bucket.byAgent, agent, 'files', fileKey);
        totals.sessions.add(parsed.sessionId);
        totals.files.add(fileKey);
        if (projectKey) totals.projects.add(projectKey);
        bumpAgent(totals.byAgent, agent, 'sessions', parsed.sessionId);
        bumpAgent(totals.byAgent, agent, 'files', fileKey);
      }
    }

    function serializeAgentMap(map) {
      const out = {};
      for (const [agent, slot] of map.entries()) {
        out[agent] = { sessions: slot.sessions.size, files: slot.files.size };
      }
      return out;
    }

    const days = [...byDate.entries()]
      .map(([date, bucket]) => ({
        date,
        sessionCount: bucket.sessions.size,
        fileCount: bucket.files.size,
        projectCount: bucket.projects.size,
        byAgent: serializeAgentMap(bucket.byAgent)
      }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    return {
      days,
      totals: {
        sessions: totals.sessions.size,
        files: totals.files.size,
        projects: totals.projects.size,
        byAgent: serializeAgentMap(totals.byAgent)
      }
    };
  }

  function invalidate() {
    cache = null;
  }

  function getStats() {
    return cache
      ? {
        builtAt: cache.builtAt,
        fileCount: cache.fileCount,
        uniquePaths: cache.entries.size,
        reused: cache.reused,
        reread: cache.reread
      }
      : null;
  }

  return { getSessionsForFile, getFilesForSession, aggregateActivity, invalidate, getStats, prewarm };
}
