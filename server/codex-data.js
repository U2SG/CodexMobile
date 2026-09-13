import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CODEX_SESSION_INDEX, CODEX_SESSIONS_DIR, CODEX_STATE_DB_PATH, readCodexConfig, readCodexWorkspaceState } from './codex-config.js';
import { CLAUDE_PROJECTS_DIR, readClaudeConfig } from './claude-config.js';
import { isClaudeMode } from './agent-mode.js';
import { currentAgentMatchesSession, sessionAgentId } from './agent-capabilities.js';
import {
  extractProposedPlanContent,
  planMessageFromContent,
  planRequestMessageFromContent
} from './plan-producer.js';
import { isCodexSystemNoiseBlock } from './desktop-thread-projector.js';
import {
  deleteMobileSessions,
  readMobileSessionIndex,
  readMobileSessionMessages,
  readMobileSessions,
  renameMobileSession
} from './mobile-session-index.js';

// A mobile registration normally gains its on-disk session file within
// seconds of the first turn; one that stays file-less this long is a dead
// first turn (API error, session limit) and would render as a phantom row.
const MOBILE_PHANTOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
import { readPinSnapshot, removePinForSession } from './pinned-sessions.js';
import {
  filterDeletedMessages,
  hideSessionInMobile,
  hideSessionMessageInLocalState,
  readDeletedMessageIds,
  readHiddenProjectIds,
  readHiddenSessionIds
} from './session-local-state.js';
import { createSessionMessageReader } from './session-message-reader.js';
import { cleanUserTextForTitle } from './claude-title-source.js';

let cache = {
  syncedAt: null,
  config: null,
  projects: [],
  projectById: new Map(),
  sessionsByProject: new Map(),
  sessionById: new Map(),
  pinFolders: []
};

const execFileAsync = promisify(execFile);

function normalizeWindowsDevicePath(value) {
  const text = String(value || '');
  if (process.platform !== 'win32') {
    return text;
  }
  if (text.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${text.slice('\\\\?\\UNC\\'.length)}`;
  }
  if (text.startsWith('\\\\?\\')) {
    return text.slice('\\\\?\\'.length);
  }
  return text;
}

export function normalizeComparablePath(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  const normalized = path.resolve(normalizeWindowsDevicePath(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function projectIdFor(projectPath) {
  return crypto.createHash('sha1').update(normalizeComparablePath(projectPath)).digest('hex').slice(0, 16);
}

function displayNameFor(projectPath) {
  const parsed = path.parse(projectPath);
  return path.basename(projectPath) || parsed.root || projectPath;
}

// Resolve a session's cwd to the path used for PROJECT GROUPING. A git linked
// worktree stores a `.git` *file* (not directory) pointing at
// `<main>/.git/worktrees/<name>`; such a worktree is mapped back to the main
// repository's working tree so its sessions group with the main project
// instead of spawning a phantom project per worktree. Plain repos / main
// worktrees (`.git` is a directory) and non-repo dirs are returned unchanged —
// we never promote a plain subdirectory to its repo root. `cache` memoizes by
// resolved cwd across one refresh pass. Note: this only affects grouping; the
// session's own `cwd` stays the worktree so resume/rename target it correctly.
// `<repo>/worktrees/<name>`, `<repo>/.claude/worktrees/<name>` and
// `<repo>/.codex/worktrees/<name>` are throwaway worktrees. Once one is
// removed, git stops tracking it (no `.git` file left behind) and the
// plain-directory rule below would strand its sessions in a row of their own.
const WORKTREE_CONTAINER_PARENTS = new Set(['.claude', '.codex']);

function toolingWorktreeRepoRoot(resolved) {
  const parts = String(resolved).split(/[\\/]/);
  for (let index = parts.length - 1; index >= 2; index -= 1) {
    if (parts[index] !== 'worktrees') {
      continue;
    }
    // `<repo>/.claude|.codex/worktrees/<name>` hides the container one level
    // deeper than the plain `<repo>/worktrees/<name>` layout.
    const skip = WORKTREE_CONTAINER_PARENTS.has(parts[index - 1]) ? 1 : 0;
    return parts.slice(0, index - skip).join(path.sep);
  }
  return '';
}

export function resolveProjectRoot(cwd, cache) {
  const resolved = path.resolve(cwd);
  if (cache && cache.has(resolved)) {
    return cache.get(resolved);
  }
  let root = resolved;
  let foundGit = false;
  try {
    let dir = resolved;
    for (;;) {
      const gitPath = path.join(dir, '.git');
      let stat;
      try {
        stat = fsSync.statSync(gitPath);
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) break; // reached filesystem root
        dir = parent;
        continue;
      }
      foundGit = true;
      if (stat.isDirectory()) {
        // Plain repo / main worktree — keep grouping by the original cwd, with
        // two exceptions that both mean "this was a worktree, and it is gone":
        // the directory no longer exists, or it is a tooling worktree slot with
        // no `.git` left. Those sessions belong to the repo we walked up to.
        if (dir !== resolved && (!fsSync.existsSync(resolved) || toolingWorktreeRepoRoot(resolved))) {
          root = dir;
        }
        break;
      }
      // `.git` is a file → linked worktree. Map back to the main repo root.
      const match = fsSync.readFileSync(gitPath, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (match) {
        const worktreeGitDir = path.resolve(dir, match[1].trim());
        let commonGitDir = path.dirname(path.dirname(worktreeGitDir)); // .../.git
        try {
          const commonRel = fsSync.readFileSync(path.join(worktreeGitDir, 'commondir'), 'utf8').trim();
          if (commonRel) {
            commonGitDir = path.resolve(worktreeGitDir, commonRel);
          }
        } catch {
          // No commondir file — fall back to the derived `.git` dir above.
        }
        root = path.dirname(commonGitDir);
      }
      break;
    }
  } catch {
    root = resolved;
  }
  if (!foundGit && root === resolved) {
    // No repo anywhere up the tree — a removed worktree whose checkout dir is
    // empty, and whose repo lives elsewhere (e.g. `D:\x\worktrees\<name>` for
    // a repo at `D:\x\<repo>`). Group it at the worktrees container's parent
    // instead of leaving one drawer row per dead checkout.
    const container = toolingWorktreeRepoRoot(resolved);
    if (container) {
      root = container;
    }
  }
  if (cache) {
    cache.set(resolved, root);
  }
  return root;
}

function toPublicProject(entry) {
  return {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    trusted: entry.trusted,
    updatedAt: entry.updatedAt,
    sessionCount: entry.sessionCount || 0
  };
}

async function walkJsonlFiles(dir) {
  const files = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent-')) {
        files.push(fullPath);
      }
    }
  }
  await walk(dir);
  return files;
}

function isoFromSqliteTime(msValue, secondsValue) {
  const ms = Number(msValue);
  if (Number.isFinite(ms) && ms > 0) {
    return new Date(ms).toISOString();
  }
  const seconds = Number(secondsValue);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000).toISOString();
  }
  return null;
}

async function readThreadStateIndex() {
  const index = new Map();
  try {
    await fs.access(CODEX_STATE_DB_PATH);
  } catch {
    return index;
  }

  const sql = `
    select
      id,
      coalesce(nullif(name, ''), nullif(title, ''), nullif(preview, ''), nullif(first_user_message, '')) as thread_name,
      updated_at_ms,
      updated_at,
      preview,
      first_user_message,
      cwd,
      model,
      model_provider,
      rollout_path
    from threads
    where archived = 0
  `;

  try {
    const { stdout } = await execFileAsync(
      process.env.CODEXMOBILE_SQLITE_BIN || 'sqlite3',
      ['-readonly', '-json', CODEX_STATE_DB_PATH, sql],
      { windowsHide: true, timeout: 10_000, maxBuffer: 10 * 1024 * 1024 }
    );
    const rows = JSON.parse(stdout || '[]');
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row?.id) {
        continue;
      }
      index.set(row.id, {
        title: row.thread_name || null,
        summary: row.preview || row.first_user_message || row.thread_name || null,
        updatedAt: isoFromSqliteTime(row.updated_at_ms, row.updated_at),
        cwd: row.cwd ? normalizeWindowsDevicePath(row.cwd) : null,
        model: row.model || null,
        provider: row.model_provider || null,
        rolloutPath: row.rollout_path || null
      });
    }
  } catch (error) {
    const code = error?.code || '';
    if (code !== 'ENOENT') {
      console.warn('[sessions] Failed to read Codex thread state:', error.message);
    }
  }
  return index;
}

async function readSessionNameIndex() {
  const index = new Map();
  try {
    const raw = await fs.readFile(CODEX_SESSION_INDEX, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const item = JSON.parse(line);
        if (item.id && item.thread_name) {
          index.set(item.id, {
            title: item.thread_name,
            updatedAt: item.updated_at || null
          });
        }
      } catch {
        // Skip malformed index rows.
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[sessions] Failed to read session index:', error.message);
    }
  }
  const threadStateIndex = await readThreadStateIndex();
  for (const [id, stateEntry] of threadStateIndex.entries()) {
    const existing = index.get(id);
    if (!existing) {
      index.set(id, stateEntry);
      continue;
    }
    const existingUpdatedAt = new Date(existing.updatedAt || 0).getTime();
    const stateUpdatedAt = new Date(stateEntry.updatedAt || 0).getTime();
    if (stateUpdatedAt > existingUpdatedAt) {
      index.set(id, {
        ...existing,
        ...stateEntry,
        title: stateEntry.title || existing.title
      });
    }
  }
  return index;
}

async function renameSessionNameIndexRow(sessionId, title, updatedAt) {
  try {
    const raw = await fs.readFile(CODEX_SESSION_INDEX, 'utf8');
    const nextLines = [];
    let changed = false;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const item = JSON.parse(line);
        if (item?.id === sessionId) {
          item.thread_name = title;
          item.updated_at = item.updated_at || updatedAt || new Date().toISOString();
          nextLines.push(JSON.stringify(item));
          changed = true;
          continue;
        }
      } catch {
        // Preserve malformed rows.
      }
      nextLines.push(line);
    }
    if (!changed) {
      nextLines.push(JSON.stringify({
        id: sessionId,
        thread_name: title,
        updated_at: updatedAt || new Date().toISOString()
      }));
    }
    await fs.writeFile(CODEX_SESSION_INDEX, `${nextLines.join('\n')}\n`, 'utf8');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.writeFile(
        CODEX_SESSION_INDEX,
        `${JSON.stringify({
          id: sessionId,
          thread_name: title,
          updated_at: updatedAt || new Date().toISOString()
        })}\n`,
        'utf8'
      );
      return true;
    }
    throw error;
  }
}

const INTERNAL_PROMPT_MARKERS = [
  'CodexMobile iOS/PWA 回复要求：',
  'CodexMobile 已接入飞书官方 lark-cli。',
  'CodexMobile 已接入飞书官方 lark-cli'
];

// Claude Code injects these XML-ish blocks as non-conversational "user" turns
// (background task completion, `! command` stdout/stderr). They carry no
// conversation value and must never render as a user bubble — drop them so
// isVisibleClaudeUserMessage filters them out of the message list, count, and
// title. Slash-command wrappers (<command-name> …) are NOT listed here: they
// are unwrapped to a readable `/cmd` by unwrapClaudeSlashCommand first.
const SYSTEM_NOISE_PREFIXES = [
  '<task-notification>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<bash-stdout>',
  '<bash-stderr>'
];

// When the user types `/cmd args` in the Claude Code terminal, the CLI
// rewrites that user message into its own three-tag storage block before
// logging it to the session file. The PWA reads the raw text back and would
// otherwise display the XML-looking tags verbatim. Recognize the block and
// flatten it back to the human-readable `/cmd args\n<trailing>` shape.
//
// The CLI emits the three tags (command-name / command-message / command-args)
// in different orders depending on which command it is — `/simplify` and
// friends start with <command-message>, built-ins like `/clear` start with
// <command-name>, and tags can be separated by arbitrary whitespace (the
// terminal indents them). Parse tag-by-tag rather than with one rigid regex.
const SLASH_TAG_RE = /^<(command-name|command-message|command-args)>([\s\S]*?)<\/\1>/;

export function unwrapClaudeSlashCommand(text) {
  const value = String(text || '');
  if (!value.startsWith('<command-')) return value;

  let remaining = value;
  const tags = Object.create(null);
  for (let i = 0; i < 3; i++) {
    const match = remaining.match(SLASH_TAG_RE);
    if (!match) break;
    const [full, name, content] = match;
    if (tags[name] !== undefined) break;
    tags[name] = content;
    remaining = remaining.slice(full.length).replace(/^\s+/, '');
  }

  const cmd = String(tags['command-name'] || '').trim();
  if (!cmd.startsWith('/')) return value;

  const args = String(tags['command-args'] || '').trim();
  const trailing = remaining.trim();
  const head = args ? `${cmd} ${args}` : cmd;
  return trailing ? `${head}\n${trailing}` : head;
}

export function sanitizeVisibleUserMessage(message) {
  const unwrapped = unwrapClaudeSlashCommand(String(message || ''));
  const value = unwrapped.trim();
  if (!value) {
    return '';
  }
  if (SYSTEM_NOISE_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return '';
  }
  let cutAt = value.length;
  for (const marker of INTERNAL_PROMPT_MARKERS) {
    const index = value.indexOf(marker);
    if (index > 0) {
      cutAt = Math.min(cutAt, index);
    }
  }
  return value.slice(0, cutAt).trim() || value;
}

function extractContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part?.type === 'output_text' || part?.type === 'input_text' || part?.type === 'text') {
        return part.text || '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function isVisibleClaudeUserMessage(entry) {
  return (
    entry?.type === 'user' &&
    !entry.isMeta &&
    entry.message?.role === 'user' &&
    sanitizeVisibleUserMessage(extractContent(entry.message.content)).trim().length > 0
  );
}

// Claude Code emits this exact sentinel as the assistant reply whenever its
// input was a meta/system-reminder prompt that requested no answer (e.g. the
// `isMeta: true` "Continue from where you left off." auto-continuation). These
// carry no conversation value and — because the meta prompt that triggered
// them is filtered out and never opens a new turn — would otherwise glue onto
// the previous real turn and hijack its conclusion slot. Drop them at parse.
const CLAUDE_NO_OP_REPLY = 'No response requested.';

function extractClaudeAssistantContent(entry) {
  if (entry?.type !== 'assistant' || entry.message?.role !== 'assistant') {
    return '';
  }
  const content = extractContent(entry.message.content);
  if (content.trim() === CLAUDE_NO_OP_REPLY) {
    return '';
  }
  return content;
}

async function readClaudeSessionFacts(filePath) {
  const stream = fsSync.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId = path.basename(filePath, '.jsonl');
  let cwd = null;
  let model = null;
  let lastTimestamp = null;
  let lastUserMessage = '';
  let firstSubstantiveMessage = '';
  let messageCount = 0;

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      if (entry.sessionId || entry.session_id) {
        sessionId = entry.sessionId || entry.session_id;
      }
      if (entry.cwd && typeof entry.cwd === 'string') {
        cwd = entry.cwd;
      }
      if (entry.message?.model) {
        model = entry.message.model;
      }
      if (entry.timestamp) {
        lastTimestamp = entry.timestamp;
      }
      if (isVisibleClaudeUserMessage(entry)) {
        messageCount += 1;
        lastUserMessage = sanitizeVisibleUserMessage(extractContent(entry.message.content));
        if (!firstSubstantiveMessage) {
          // Prefer the first real question as the title fallback — the last
          // user line is often a slash command / interruption / paste.
          firstSubstantiveMessage = cleanUserTextForTitle(lastUserMessage);
        }
      }
      if (extractClaudeAssistantContent(entry).trim()) {
        messageCount += 1;
      }
    } catch {
      // Skip malformed or partial rows.
    }
  }

  if (!sessionId || !cwd) {
    return null;
  }
  return {
    sessionId,
    cwd,
    model,
    lastTimestamp,
    lastUserMessage: lastUserMessage.slice(0, SESSION_PREVIEW_CHARS),
    firstSubstantiveMessage: firstSubstantiveMessage.slice(0, SESSION_PREVIEW_CHARS),
    messageCount
  };
}

function claudeSessionFromFacts(facts, filePath, mobileSessionIndex, worktreeRootCache) {
  if (!facts) {
    return null;
  }
  const { sessionId, cwd, model, lastTimestamp, lastUserMessage, firstSubstantiveMessage, messageCount } = facts;
  const mobileSession = mobileSessionIndex.get(sessionId);
  const mobileMessages = Array.isArray(mobileSession?.messages) ? mobileSession.messages : [];
  const updatedAt =
    mobileSession?.updatedAt && (!lastTimestamp || new Date(mobileSession.updatedAt) > new Date(lastTimestamp))
      ? mobileSession.updatedAt
      : lastTimestamp;

  const groupRoot = resolveProjectRoot(cwd, worktreeRootCache);

  return {
    id: sessionId,
    cwd: path.resolve(cwd),
    // groupRoot maps a git worktree back to its main repo for project grouping;
    // it equals the resolved cwd for plain dirs. cwd above stays the worktree.
    groupRoot,
    projectId: projectIdFor(groupRoot),
    // Fall back to the first substantive message, then "新对话" — never the raw
    // last line, which for content-free sessions is a /clear, a goodbye, or a
    // <local-command-stdout> marker.
    title: mobileSession?.title || (firstSubstantiveMessage ? firstSubstantiveMessage.slice(0, 52) : '新对话'),
    titleLocked: Boolean(mobileSession?.titleLocked),
    summary: mobileSession?.summary || lastUserMessage || 'Claude Code 会话',
    model,
    provider: 'claude',
    messageCount: messageCount + mobileMessages.length,
    updatedAt,
    source: 'claude-code',
    filePath
  };
}

async function readCodexSessionFacts(filePath) {
  const stream = fsSync.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let meta = null;
  let threadSource = null;
  let sawSessionMeta = false;
  let lastTimestamp = null;
  let firstUserMessage = '';
  let lastUserMessage = '';
  let messageCount = 0;

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      if (entry.timestamp) {
        lastTimestamp = entry.timestamp;
      }
      // Identity comes from the LAST session_meta row: a resumed or forked
      // rollout appends a second session_meta naming the thread it continues,
      // and its body replays that thread's history. Keying on the file's own
      // id instead would list the same conversation twice — measured on this
      // host: 51 extra rows, each a partial replay of a row already present.
      // `thread_source`, however, only means anything on the FIRST row (the
      // later one describes the ancestor).
      if (entry.type === 'session_meta' && entry.payload?.id) {
        if (!sawSessionMeta) {
          sawSessionMeta = true;
          threadSource = entry.payload.thread_source || null;
        }
        meta = {
          id: entry.payload.id,
          cwd: entry.payload.cwd,
          model: entry.payload.model || null,
          provider: entry.payload.model_provider || null,
          timestamp: entry.timestamp || entry.payload.timestamp || null
        };
      }
      // Codex 0.149+ dropped `event_msg` user_message/agent_message rows (the
      // stream is generic `item_completed` wrappers now), so both counts and
      // the title fallback have to come from `response_item` messages — the
      // same rows messagesFromRolloutJsonl renders.
      if (entry.type === 'response_item' && entry.payload?.type === 'message') {
        const role = entry.payload.role;
        if (role === 'user') {
          const text = sanitizeVisibleUserMessage(extractContent(entry.payload.content));
          if (text.trim() && !isCodexSystemNoiseBlock(text)) {
            messageCount += 1;
            if (!firstUserMessage) firstUserMessage = text;
            lastUserMessage = text;
          }
        } else if (role === 'assistant' && entry.payload.phase !== 'commentary') {
          messageCount += 1;
        }
      }
    } catch {
      // Skip malformed or partial rows.
    }
  }

  if (!meta?.id || !meta.cwd) {
    return null;
  }
  // Subagent transcripts are worker threads spawned inside a conversation, not
  // conversations the user started. Codex 0.149 spawns them freely, and their
  // last session_meta names the parent thread — so without this they compete
  // with the parent's own rollout in the dedup below and can replace a real
  // conversation with a worker's transcript.
  if (threadSource === 'subagent') {
    return null;
  }
  // Only a title (52 chars) and a one-line drawer summary are ever rendered
  // from these, so store a preview instead of whole prompts — the cache is
  // persisted and full transcripts would bloat it by megabytes.
  return {
    meta,
    lastTimestamp,
    firstUserMessage: firstUserMessage.slice(0, SESSION_PREVIEW_CHARS),
    lastUserMessage: lastUserMessage.slice(0, SESSION_PREVIEW_CHARS),
    messageCount
  };
}

function codexSessionFromFacts(facts, filePath, sessionIndex, mobileSessionIndex, worktreeRootCache) {
  if (!facts) {
    return null;
  }
  const { meta, lastTimestamp, firstUserMessage, lastUserMessage, messageCount } = facts;
  const indexedSession = sessionIndex.get(meta.id);
  const mobileSession = mobileSessionIndex.get(meta.id);
  // Drop ghost sessions: rollout exists on disk but Codex CLI's session_index
  // doesn't list it, so resumeThread will fail with "no rollout found". Keep
  // mobile-registered sessions even if absent from CLI index — they may be
  // mobile-only or freshly created and pending index sync. Set
  // CODEXMOBILE_SHOW_UNRESUMABLE=1 to bypass this filter for diagnostics.
  if (!indexedSession && !mobileSession && process.env.CODEXMOBILE_SHOW_UNRESUMABLE !== '1') {
    return null;
  }
  const indexEntry = indexedSession || mobileSession || {};
  const mobileMessages = Array.isArray(mobileSession?.messages) ? mobileSession.messages : [];
  const updatedAt = latestIso(mobileSession?.updatedAt, indexEntry.updatedAt, lastTimestamp, meta.timestamp);

  // groupRoot maps a git worktree back to its main repo so worktree sessions
  // group under the parent project instead of each becoming its own row; it
  // equals the resolved cwd for plain directories.
  const groupRoot = resolveProjectRoot(meta.cwd, worktreeRootCache);

  return {
    id: meta.id,
    cwd: path.resolve(meta.cwd),
    groupRoot,
    projectId: projectIdFor(groupRoot),
    // Title fallback uses the FIRST user message, not the last — otherwise the
    // drawer label tracks whatever the user just typed and flickers between
    // turns. mobileSession.title / indexEntry.title already capture the
    // session's "real" name once auto-naming or a manual rename has run.
    title: mobileSession?.title || indexEntry.title || (firstUserMessage ? firstUserMessage.slice(0, 52) : '新对话'),
    titleLocked: Boolean(mobileSession?.titleLocked),
    summary: mobileSession?.summary || lastUserMessage || indexEntry.summary || indexEntry.title || 'Codex 会话',
    model: meta.model || indexEntry.model || null,
    provider: meta.provider || indexEntry.provider || null,
    messageCount: messageCount + mobileMessages.length,
    updatedAt,
    source: 'codex-app',
    filePath
  };
}

// Reading every rollout/transcript file is the whole cost of a refresh: 882
// codex rollouts on this host took 121s cold / 34s warm, and refreshCodexCache
// runs both at boot (before listen) and on every client `POST /api/sync`.
// The file-derived facts only change when the file does, so memoize them by
// (path, mtime, size) and re-apply the cheap index/mobile/worktree merge every
// time. The map is persisted so a restart doesn't pay the cold price again.
const SESSION_FACTS_CACHE_VERSION = 1;
const SESSION_PREVIEW_CHARS = 200;
const STATE_DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), '.codexmobile', 'state');
const sessionFactsCache = new Map();
let sessionFactsCacheLoaded = false;
let sessionFactsCacheDirty = false;

function sessionFactsCachePath() {
  return (
    process.env.CODEXMOBILE_SESSION_FACTS_CACHE ||
    path.join(STATE_DIR, `session-facts-${isClaudeMode() ? 'claude' : 'codex'}.json`)
  );
}

async function loadSessionFactsCache() {
  if (sessionFactsCacheLoaded) {
    return;
  }
  sessionFactsCacheLoaded = true;
  try {
    const raw = JSON.parse(await fs.readFile(sessionFactsCachePath(), 'utf8'));
    if (raw?.version !== SESSION_FACTS_CACHE_VERSION || !raw.entries) {
      return;
    }
    for (const [filePath, entry] of Object.entries(raw.entries)) {
      if (entry && Number.isFinite(entry.mtimeMs) && Number.isFinite(entry.size)) {
        sessionFactsCache.set(filePath, entry);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[sessions] Failed to read session facts cache:', error.message);
    }
  }
}

async function saveSessionFactsCache() {
  if (!sessionFactsCacheDirty) {
    return;
  }
  sessionFactsCacheDirty = false;
  const payload = { version: SESSION_FACTS_CACHE_VERSION, entries: Object.fromEntries(sessionFactsCache) };
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    const tmp = `${sessionFactsCachePath()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload));
    await fs.rename(tmp, sessionFactsCachePath());
  } catch (error) {
    console.warn('[sessions] Failed to write session facts cache:', error.message);
  }
}

async function readSessionFacts(filePath, read) {
  let stat = null;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  const cached = sessionFactsCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.facts;
  }
  const facts = await read(filePath);
  sessionFactsCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, facts });
  sessionFactsCacheDirty = true;
  return facts;
}

function pruneSessionFactsCache(livePaths) {
  for (const filePath of sessionFactsCache.keys()) {
    if (!livePaths.has(filePath)) {
      sessionFactsCache.delete(filePath);
      sessionFactsCacheDirty = true;
    }
  }
}

export async function parseSessionMetadata(filePath, sessionIndex, mobileSessionIndex, worktreeRootCache = new Map()) {
  const facts = await readCodexSessionFacts(filePath);
  return codexSessionFromFacts(facts, filePath, sessionIndex, mobileSessionIndex, worktreeRootCache);
}

function upsertProject(projectMap, projectPath, trustLevel = null, label = null) {
  const normalized = normalizeComparablePath(projectPath);
  if (!normalized) {
    return null;
  }
  const id = projectIdFor(projectPath);
  const existing = projectMap.get(id);
  if (existing) {
    if (trustLevel) {
      existing.trusted = trustLevel === 'trusted';
    }
    if (label) {
      existing.name = label;
    }
    return existing;
  }
  const entry = {
    id,
    name: label || displayNameFor(projectPath),
    // Strip the Windows `\\?\` device prefix before resolving — config.toml
    // and the desktop state DB both hand out device paths, and path.resolve
    // turns them into `D:\?\D:\...` phantoms.
    path: path.resolve(normalizeWindowsDevicePath(projectPath)),
    trusted: trustLevel === 'trusted',
    updatedAt: null,
    sessionCount: 0
  };
  projectMap.set(id, entry);
  return entry;
}

function sessionUpdatedAtMs(session) {
  const value = session?.updatedAt;
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function latestIso(...values) {
  let latestValue = null;
  let latestTime = 0;
  for (const value of values) {
    if (!value) {
      continue;
    }
    const time = new Date(value).getTime();
    if (Number.isFinite(time) && time > latestTime) {
      latestValue = value;
      latestTime = time;
    }
  }
  return latestValue;
}

export function mergeProjectSources(workspaceProjects = [], configProjects = []) {
  const configByPath = new Map();
  for (const project of configProjects) {
    const key = normalizeComparablePath(project?.path);
    if (key) {
      configByPath.set(key, project);
    }
  }

  const seen = new Set();
  const projects = [];
  function addProject(project, source = 'config') {
    const key = normalizeComparablePath(project?.path);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    const configProject = configByPath.get(key);
    projects.push({
      path: normalizeWindowsDevicePath(project.path),
      trustLevel: project.trustLevel || configProject?.trustLevel || 'trusted',
      label: source === 'workspace' ? project.label : null
    });
  }

  for (const project of workspaceProjects) {
    addProject(project, 'workspace');
  }
  for (const project of configProjects) {
    addProject(project, 'config');
  }
  return projects;
}

export function upsertLatestSession(session, sessionsByProject, sessionById, project) {
  const existing = sessionById.get(session.id);
  if (existing) {
    if (sessionUpdatedAtMs(session) <= sessionUpdatedAtMs(existing)) {
      return;
    }
    const previousList = sessionsByProject.get(existing.projectId);
    if (previousList) {
      const idx = previousList.findIndex((entry) => entry.id === session.id);
      if (idx >= 0) previousList.splice(idx, 1);
    }
  }
  if (!sessionsByProject.has(project.id)) {
    sessionsByProject.set(project.id, []);
  }
  sessionsByProject.get(project.id).push(session);
  sessionById.set(session.id, session);
}

export async function refreshCodexCache() {
  const claudeMode = isClaudeMode();
  const config = claudeMode ? await readClaudeConfig() : await readCodexConfig();
  const workspaceState = claudeMode ? { projects: [] } : await readCodexWorkspaceState();
  const sessionIndex = await readSessionNameIndex();
  const mobileSessionIndex = await readMobileSessionIndex();
  const mobileSessions = await readMobileSessions();
  const hiddenProjectIds = await readHiddenProjectIds();
  const hiddenSessionIds = await readHiddenSessionIds();
  const pinSnapshot = await readPinSnapshot();
  const validFolderIds = new Set(pinSnapshot.folders.map((folder) => folder.id));
  const projectById = new Map();
  const sessionsByProject = new Map();
  const sessionById = new Map();

  const visibleProjects = mergeProjectSources(workspaceState.projects, config.projects)
    .filter((project) => !hiddenProjectIds.has(projectIdFor(project.path)));
  const visibleProjectIds = new Set();

  for (const project of visibleProjects) {
    const entry = upsertProject(projectById, project.path, project.trustLevel, project.label);
    if (entry) {
      visibleProjectIds.add(entry.id);
    }
  }

  await loadSessionFactsCache();
  const files = await walkJsonlFiles(claudeMode ? CLAUDE_PROJECTS_DIR : CODEX_SESSIONS_DIR);
  const worktreeRootCache = new Map();
  for (const file of files) {
    const facts = await readSessionFacts(file, claudeMode ? readClaudeSessionFacts : readCodexSessionFacts);
    const session = claudeMode
      ? claudeSessionFromFacts(facts, file, mobileSessionIndex, worktreeRootCache)
      : codexSessionFromFacts(facts, file, sessionIndex, mobileSessionIndex, worktreeRootCache);
    if (!session) {
      continue;
    }
    if (hiddenSessionIds.has(session.id)) {
      continue;
    }
    if (hiddenProjectIds.has(session.projectId)) {
      continue;
    }
    if (!visibleProjectIds.has(session.projectId) && session.cwd) {
      const entry = upsertProject(projectById, session.groupRoot || session.cwd, 'trusted', null);
      if (entry) {
        visibleProjectIds.add(entry.id);
      }
    }
    if (!visibleProjectIds.has(session.projectId)) {
      continue;
    }
    const project = projectById.get(session.projectId);
    if (!project) {
      continue;
    }
    // Dedup: a resumed rollout file writes its parent session's id in a later
    // session_meta entry, so parseSessionMetadata returns that parent id even
    // though the file is physically separate. Without this dedup the same id
    // would land in sessionsByProject twice (count mismatch with the visible
    // list) while sessionById would silently overwrite to the last one parsed.
    // Keep the entry with the latest updatedAt — the resume file contains the
    // newer increments and its filePath is the right one to read from later.
    upsertLatestSession(session, sessionsByProject, sessionById, project);
  }
  pruneSessionFactsCache(new Set(files));
  await saveSessionFactsCache();

  const stalePhantomIds = [];
  for (const mobileSession of mobileSessions) {
    if (!mobileSession?.id || !mobileSession.projectPath || sessionById.has(mobileSession.id)) {
      continue;
    }
    // A registration whose session never materialized on disk (failed first
    // turn, deleted session file) would otherwise sit in the drawer forever as
    // a phantom row carrying the user's sent message. Prune it once it is
    // clearly dead — but only records this agent owns: the state file is
    // shared with the sibling server, whose sessions are absent from OUR
    // sessionById by design.
    if (
      currentAgentMatchesSession(mobileSession) &&
      sessionAgentId(mobileSession) !== 'unknown' &&
      sessionUpdatedAtMs(mobileSession) < Date.now() - MOBILE_PHANTOM_TTL_MS
    ) {
      stalePhantomIds.push(mobileSession.id);
      continue;
    }
    if (hiddenSessionIds.has(mobileSession.id)) {
      continue;
    }
    // Group like disk sessions do: resolveProjectRoot maps a git linked
    // worktree back to its main repo, so the mobile-registered row lands in
    // the same project group as the on-disk session it precedes.
    const projectId = projectIdFor(resolveProjectRoot(mobileSession.projectPath, worktreeRootCache));
    if (hiddenProjectIds.has(projectId)) {
      continue;
    }
    if (!visibleProjectIds.has(projectId)) {
      continue;
    }
    const project = projectById.get(projectId);
    if (!project) {
      continue;
    }
    const messages = Array.isArray(mobileSession.messages) ? mobileSession.messages : [];
    const session = {
      id: mobileSession.id,
      cwd: path.resolve(mobileSession.projectPath),
      projectId,
      title: mobileSession.title || mobileSession.summary?.slice(0, 52) || '新对话',
      titleLocked: Boolean(mobileSession.titleLocked),
      summary: mobileSession.summary || mobileSession.title || 'CodexMobile 对话',
      model: mobileSession.model || null,
      provider: mobileSession.provider || null,
      messageCount: messages.length,
      updatedAt: mobileSession.updatedAt || null,
      source: mobileSession.source || 'codexmobile',
      filePath: null,
      mobileOnly: true
    };
    if (!sessionsByProject.has(project.id)) {
      sessionsByProject.set(project.id, []);
    }
    sessionsByProject.get(project.id).push(session);
    sessionById.set(session.id, session);
  }

  if (stalePhantomIds.length) {
    deleteMobileSessions(stalePhantomIds).catch((error) => {
      console.warn('[mobile-sessions] Failed to prune phantom registrations:', error.message);
    });
    console.log(`[mobile-sessions] pruned ${stalePhantomIds.length} phantom registration(s) with no on-disk session`);
  }

  for (const [projectId, sessions] of sessionsByProject.entries()) {
    for (const session of sessions) {
      const pin = pinSnapshot.pinned.get(session.id);
      if (pin) {
        session.pinned = true;
        session.pinnedAt = pin.pinnedAt;
        session.folderId = pin.folderId && validFolderIds.has(pin.folderId) ? pin.folderId : null;
      } else {
        session.pinned = false;
        session.pinnedAt = null;
        session.folderId = null;
      }
    }
    sessions.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && b.pinned) {
        return new Date(b.pinnedAt || 0) - new Date(a.pinnedAt || 0);
      }
      return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    });
    const project = projectById.get(projectId);
    if (project) {
      project.sessionCount = sessions.length;
      const firstUnpinned = sessions.find((session) => !session.pinned);
      project.updatedAt = (firstUnpinned || sessions[0])?.updatedAt || project.updatedAt;
    }
  }

  const projectOrder = new Map(visibleProjects.map((project, index) => [projectIdFor(project.path), index]));
  const projects = [...projectById.values()].sort((a, b) => {
    const orderA = projectOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const orderB = projectOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return orderA - orderB || a.name.localeCompare(b.name, 'zh-Hans-CN');
  });

  cache = {
    syncedAt: new Date().toISOString(),
    config,
    projects,
    projectById,
    sessionsByProject,
    sessionById,
    pinFolders: pinSnapshot.folders
  };

  return getCacheSnapshot();
}

export function getCacheSnapshot() {
  return {
    syncedAt: cache.syncedAt,
    config: cache.config,
    projects: cache.projects.map(toPublicProject),
    pinFolders: cache.pinFolders
  };
}

export function getPinFolders() {
  return cache.pinFolders;
}

export function listProjects() {
  return cache.projects.map(toPublicProject);
}

export function getProject(projectId) {
  return cache.projectById.get(projectId) || null;
}

export function listProjectSessions(projectId) {
  return (cache.sessionsByProject.get(projectId) || []).map((session) => ({
    id: session.id,
    title: session.title,
    titleLocked: Boolean(session.titleLocked),
    summary: session.summary,
    model: session.model,
    provider: session.provider,
    source: session.source,
    messageCount: session.messageCount,
    updatedAt: session.updatedAt,
    pinned: Boolean(session.pinned),
    pinnedAt: session.pinnedAt || null,
    folderId: session.folderId || null
  }));
}

export function getSession(sessionId) {
  return cache.sessionById.get(sessionId) || null;
}

// Claude terminal sessions that still carry the sliced first-message title
// (never went through any auto-namer). Excludes locked titles and content-free
// sessions (title === '新对话'). Used by the sync-time background auto-titler.
export function listSessionsNeedingClaudeTitle() {
  const out = [];
  for (const session of cache.sessionById.values()) {
    if (
      session.source === 'claude-code' &&
      !session.titleLocked &&
      session.filePath &&
      session.title &&
      session.title !== '新对话'
    ) {
      out.push({ id: session.id, filePath: session.filePath, projectPath: session.cwd });
    }
  }
  return out;
}

export async function renameSession(sessionId, projectId, title) {
  const session = getSession(sessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.statusCode = 404;
    throw error;
  }
  if (projectId && session.projectId !== projectId) {
    const error = new Error('Session not found in project');
    error.statusCode = 404;
    throw error;
  }

  const nextTitle = String(title || '').trim().slice(0, 52);
  if (!nextTitle) {
    const error = new Error('Title is required');
    error.statusCode = 400;
    throw error;
  }

  if (session.filePath) {
    await renameSessionNameIndexRow(session.id, nextTitle, session.updatedAt);
  }
  await renameMobileSession({
    id: session.id,
    projectPath: session.cwd,
    title: nextTitle,
    updatedAt: session.updatedAt
  });

  return { ...session, title: nextTitle };
}

export async function deleteSession(sessionId, projectId) {
  const session = getSession(sessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.statusCode = 404;
    throw error;
  }
  if (projectId && session.projectId !== projectId) {
    const error = new Error('Session not found in project');
    error.statusCode = 404;
    throw error;
  }

  const hidden = await hideSessionInMobile(session);
  await removePinForSession(sessionId);

  return {
    deletedSessionId: sessionId,
    projectId: session.projectId,
    hiddenOnly: true,
    hiddenAt: hidden.hiddenAt,
    deletedFile: false,
    deletedIndexRows: false,
    deletedMobileRecord: false
  };
}

export const hideSessionMessage = hideSessionMessageInLocalState;

async function findSessionFile(sessionId) {
  const cached = cache.sessionById.get(sessionId)?.filePath;
  if (cached) {
    return cached;
  }
  const files = await walkJsonlFiles(isClaudeMode() ? CLAUDE_PROJECTS_DIR : CODEX_SESSIONS_DIR);
  return files.find((file) => path.basename(file).includes(sessionId)) || null;
}

const codexSessionMessageReader = createSessionMessageReader({
  readDeletedMessageIds: async () => new Set(),
  filterDeletedMessages: (messages) => messages,
  resolveSessionThread: async (sessionId) => {
    const session = cache.sessionById.get(sessionId) || {};
    const filePath = session.filePath || await findSessionFile(sessionId);
    return filePath ? { ...session, id: sessionId, filePath, path: filePath } : null;
  }
});

function paginateMessages(messages, { limit = 120, offset = null, latest = true } = {}) {
  const total = messages.length;
  const count = Number(limit) || 0;
  const hasOffset = offset !== null && offset !== undefined;
  const start = hasOffset
    ? Math.max(0, Number(offset) || 0)
    : latest && count
      ? Math.max(0, total - count)
      : 0;
  const end = count ? start + count : undefined;
  return {
    messages: messages.slice(start, end),
    total,
    offset: start,
    hasMore: end ? end < total : false,
    hasMoreBefore: start > 0
  };
}

async function readLegacySessionMessages(sessionId, { limit = 120, offset = null, latest = true } = {}) {
  const filePath = await findSessionFile(sessionId);
  const mobileMessages = await readMobileSessionMessages(sessionId);
  const deletedIds = await readDeletedMessageIds(sessionId);
  if (!filePath) {
    return paginateMessages(filterDeletedMessages(mobileMessages, deletedIds), { limit, offset, latest });
  }

  const messages = [];
  const stream = fsSync.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  // Claude / legacy codex history files have no explicit "turn boundary"
  // marker the way modern codex rollouts do (`turn_context`). To let the
  // client group multi-segment assistant replies into one visual bubble,
  // we synthesize a turn id whenever a user message appears and tag every
  // following assistant/plan record with it until the next user.
  let currentTurnId = null;
  let synthTurnCounter = 0;

  // The PWA stores each outgoing user message locally before claude-code
  // ever sees it; the claude CLI then logs the same message back to its
  // session file, often with a `<cwd-basename>\n` prefix it injects. Both
  // copies surface in the merged view — same role, same logical send, two
  // different ids — and the user sees their bubble twice. Build a content
  // lookup of the mobile copies up-front; when we encounter a parsed user
  // message whose body (or its tail after the cwd prefix) matches one of
  // them, skip the parsed copy and let the merge below carry the cleaner
  // mobile version into the message list. We still bump `currentTurnId`
  // so the assistant replies that follow get the right grouping anchor.
  const mobileUserContents = new Set();
  for (const m of mobileMessages) {
    if (m.role === 'user' && typeof m.content === 'string') {
      const trimmed = m.content.trim();
      if (trimmed) mobileUserContents.add(trimmed);
    }
  }
  function parsedUserDupesMobile(content) {
    const trimmed = String(content || '').trim();
    if (!trimmed || mobileUserContents.size === 0) return false;
    if (mobileUserContents.has(trimmed)) return true;
    const nlIndex = trimmed.indexOf('\n');
    if (nlIndex > 0) {
      const tail = trimmed.slice(nlIndex + 1).trim();
      if (tail && mobileUserContents.has(tail)) return true;
    }
    return false;
  }

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      const timestamp = entry.timestamp || null;

      if (isClaudeMode()) {
        if (isVisibleClaudeUserMessage(entry)) {
          const userId = entry.uuid || `${entry.timestamp || messages.length}-user`;
          currentTurnId = `turn-${entry.uuid || ++synthTurnCounter}`;
          const userContent = sanitizeVisibleUserMessage(extractContent(entry.message.content));
          if (!parsedUserDupesMobile(userContent)) {
            messages.push({
              id: userId,
              role: 'user',
              content: userContent,
              timestamp,
              turnId: currentTurnId
            });
          }
        }

        const assistantContent = extractClaudeAssistantContent(entry);
        if (assistantContent.trim()) {
          const baseId = entry.uuid || entry.message?.id || `${entry.timestamp || messages.length}-assistant`;
          const proposedPlan = extractProposedPlanContent(assistantContent);
          if (proposedPlan) {
            const planMsg = planMessageFromContent({ id: `${baseId}-plan`, content: proposedPlan, timestamp });
            const reqMsg = planRequestMessageFromContent({ id: `${baseId}-plan-request`, content: proposedPlan, timestamp });
            if (planMsg) { planMsg.turnId = currentTurnId; messages.push(planMsg); }
            if (reqMsg) { reqMsg.turnId = currentTurnId; messages.push(reqMsg); }
          } else {
            messages.push({ id: baseId, role: 'assistant', content: assistantContent, timestamp, turnId: currentTurnId });
          }
        }
        continue;
      }

      // User turns come from `response_item` messages, present in both the
      // pre- and post-0.149 rollout formats (0.149 dropped the `event_msg`
      // user_message row entirely). Same rows the three-layer reader renders,
      // so the two paths agree on what a "message" is.
      if (
        entry.type === 'response_item' &&
        entry.payload?.type === 'message' &&
        entry.payload.role === 'user'
      ) {
        const userContent = sanitizeVisibleUserMessage(extractContent(entry.payload.content));
        if (userContent.trim() && !isCodexSystemNoiseBlock(userContent)) {
          const userId = entry.payload.id || `${entry.timestamp || messages.length}-user`;
          currentTurnId = `turn-${userId}`;
          messages.push({
            id: userId,
            role: 'user',
            content: userContent,
            timestamp,
            turnId: currentTurnId
          });
        }
      }

      if (
        entry.type === 'response_item' &&
        entry.payload?.type === 'message' &&
        entry.payload.role === 'assistant' &&
        entry.payload.phase !== 'commentary'
      ) {
        const content = extractContent(entry.payload.content);
        if (content.trim()) {
          const baseId = entry.payload.id || `${entry.timestamp || messages.length}-assistant`;
          const proposedPlan = extractProposedPlanContent(content);
          if (proposedPlan) {
            const planMsg = planMessageFromContent({ id: `${baseId}-plan`, content: proposedPlan, timestamp });
            const reqMsg = planRequestMessageFromContent({ id: `${baseId}-plan-request`, content: proposedPlan, timestamp });
            if (planMsg) { planMsg.turnId = currentTurnId; messages.push(planMsg); }
            if (reqMsg) { reqMsg.turnId = currentTurnId; messages.push(reqMsg); }
          } else {
            messages.push({ id: baseId, role: entry.payload.role || 'assistant', content, timestamp, turnId: currentTurnId });
          }
        }
      }

    } catch {
      // Skip malformed rows.
    }
  }

  for (const message of mobileMessages) {
    if (!messages.some((item) => item.id === message.id)) {
      messages.push(message);
    }
  }
  messages.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

  return paginateMessages(filterDeletedMessages(messages, deletedIds), { limit, offset, latest });
}

export async function readSessionMessages(
  sessionId,
  { limit = 120, offset = null, latest = true, includeActivity = false } = {}
) {
  if (isClaudeMode()) {
    return readLegacySessionMessages(sessionId, { limit, offset, latest });
  }

  const filePath = await findSessionFile(sessionId);
  const mobileMessages = await readMobileSessionMessages(sessionId);
  const deletedIds = await readDeletedMessageIds(sessionId);
  if (!filePath) {
    return paginateMessages(filterDeletedMessages(mobileMessages, deletedIds), { limit, offset, latest });
  }

  let result;
  try {
    result = await codexSessionMessageReader.readSessionMessages(sessionId, {
      limit: 0,
      offset: null,
      latest: false,
      includeActivity
    });
  } catch (error) {
    const expectedFallback =
      error?.statusCode === 404 ||
      error?.code === 'CODEXMOBILE_DESKTOP_BRIDGE_UNAVAILABLE' ||
      /spawn\s+codex(?:\.\w+)?\s+ENOENT/i.test(error?.message || '');
    if (!expectedFallback) {
      console.warn(`[sessions] session-message-reader fallback session=${sessionId}: ${error.message}`);
    }
    return readLegacySessionMessages(sessionId, { limit, offset, latest });
  }

  const messages = Array.isArray(result.messages) ? [...result.messages] : [];
  for (const message of mobileMessages) {
    if (!messages.some((item) => item.id === message.id)) {
      messages.push(message);
    }
  }
  messages.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

  return {
    ...paginateMessages(filterDeletedMessages(messages, deletedIds), { limit, offset, latest }),
    context: result.context
  };
}

export function getHostName() {
  return os.hostname();
}

export async function findClaudeSessionJsonlPath(sessionId) {
  return findSessionFile(sessionId);
}
