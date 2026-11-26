import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { liveEnv } from './env-file.js';

const execFileAsync = promisify(execFile);

export const AGY_HOME = process.env.AGY_HOME || path.join(os.homedir(), '.gemini', 'antigravity-cli');
export const AGY_SUMMARIES_DB_PATH = path.join(AGY_HOME, 'conversation_summaries.db');
export const AGY_BRAIN_DIR = path.join(AGY_HOME, 'brain');
export const DEFAULT_AGY_MODEL = 'gemini-4-neon-high';

const AGY_MODEL_LABELS = {
  'gemini-4-neon-high': 'Gemini 4 Neon (High)',
  'gemini-4-neon-xhigh': 'Gemini 4 Neon (XHigh)',
  'gemini-4-neon-medium': 'Gemini 4 Neon (Medium)',
  'gemini-4-neon-low': 'Gemini 4 Neon (Low)',
  'gemini-4-carbon-high': 'Gemini 4 Carbon (High)',
  'gemini-4-carbon-medium': 'Gemini 4 Carbon (Medium)',
  'gemini-4-carbon-low': 'Gemini 4 Carbon (Low)',
  'gemini-4-argon-high': 'Gemini 4 Argon (High)',
  'gemini-4-argon-medium': 'Gemini 4 Argon (Medium)',
  'gemini-4-hydrogen-high': 'Gemini 4 Hydrogen (High)',
  'gemini-4-hydrogen-xhigh': 'Gemini 4 Hydrogen (XHigh)',
  'gemini-3.8-flash-high': 'Gemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium': 'Gemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
  'claude-opus-5-5-high': 'Claude Opus 5.5 (High)',
  'claude-opus-5-5-medium': 'Claude Opus 5.5 (Medium)',
  'claude-sonnet-5-5-high': 'Claude Sonnet 5.5 (High)',
  'claude-sonnet-5-5-medium': 'Claude Sonnet 5.5 (Medium)',
  'gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)'
};

const DEFAULT_AGY_MODELS = [
  'gemini-4-neon-high',
  'gemini-4-neon-xhigh',
  'gemini-4-neon-medium',
  'gemini-4-carbon-high',
  'gemini-4-carbon-medium',
  'gemini-4-hydrogen-high',
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'claude-opus-5-5-high',
  'claude-sonnet-5-5-high'
];

const SUMMARIES_SQL = `
SELECT
  conversation_id,
  title,
  preview,
  step_count,
  last_modified_time,
  workspace_uris,
  status,
  source,
  parent_conversation_id,
  nesting_depth,
  last_user_input_time
FROM conversation_summaries
WHERE (parent_conversation_id = '' OR parent_conversation_id IS NULL)
  AND nesting_depth = 0
  AND step_count > 0
ORDER BY last_modified_time DESC
`;

const summariesCacheByDb = new Map();

function titleCase(value) {
  return String(value || '').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatAgyModelLabel(model) {
  const id = String(model || DEFAULT_AGY_MODEL).trim() || DEFAULT_AGY_MODEL;
  if (AGY_MODEL_LABELS[id]) {
    return AGY_MODEL_LABELS[id];
  }
  const effortMatch = id.match(/^(.*)-(low|medium|high|xhigh|max)$/i);
  if (effortMatch) {
    const base = titleCase(effortMatch[1].replace(/-/g, ' '));
    const effort = effortMatch[2].toLowerCase() === 'xhigh' ? 'XHigh' : titleCase(effortMatch[2].toLowerCase());
    return `${base} (${effort})`;
  }
  return titleCase(id.replace(/-/g, ' '));
}

export function shortAgyModelName(model) {
  const id = String(model || DEFAULT_AGY_MODEL).trim() || DEFAULT_AGY_MODEL;
  return id
    .replace(/^gemini-/i, 'G')
    .replace(/^claude-/i, 'C ')
    .replace(/-/g, ' ');
}

export function buildAgyModelList(rawValue, currentModel = DEFAULT_AGY_MODEL) {
  const raw = String(rawValue || '').trim();
  const ids = raw
    ? raw.split(',').map((entry) => entry.trim()).filter(Boolean)
    : [...DEFAULT_AGY_MODELS];
  if (currentModel && !ids.includes(currentModel)) {
    ids.unshift(currentModel);
  }
  const seen = new Set();
  const list = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push({ value: id, label: formatAgyModelLabel(id) });
  }
  return list;
}

export function parseWorkspaceUri(uri) {
  const raw = String(uri || '').trim();
  if (!raw) return null;
  if (raw.startsWith('file://')) {
    try {
      return path.resolve(fileURLToPath(raw));
    } catch {
      return null;
    }
  }
  if (path.isAbsolute(raw)) {
    return path.resolve(raw);
  }
  return null;
}

export function parseWorkspaceUris(value) {
  if (!value) return [];
  let items = [];
  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) items = parsed;
      } catch {
        items = [trimmed];
      }
    } else {
      items = [trimmed];
    }
  }
  const paths = [];
  const seen = new Set();
  for (const item of items) {
    const resolved = parseWorkspaceUri(item);
    if (!resolved) continue;
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(resolved);
  }
  return paths;
}

export function agyTranscriptPath(conversationId, agyHome = AGY_HOME) {
  const id = String(conversationId || '').trim();
  if (!id) return null;
  return path.join(agyHome, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
}

export function normalizeAgyTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('0001-01-01')) {
    return null;
  }
  // Go SQLite timestamps can look like "2026-11-25 14:15:49.33987+00:00".
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const ms = new Date(normalized).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function extractAgyUserText(content) {
  const raw = String(content || '');
  if (!raw.trim()) return '';
  const match = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (match) {
    return match[1].trim();
  }
  return raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '')
    .trim();
}

async function dbSignature(dbPath) {
  const [db, wal] = await Promise.all([
    fs.stat(dbPath),
    fs.stat(`${dbPath}-wal`).catch(() => null)
  ]);
  return `${db.mtimeMs}:${db.size}:${wal?.mtimeMs || 0}:${wal?.size || 0}`;
}

async function querySummariesRows(dbPath) {
  let sqlite = null;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    // Node < 22.5: fall back to sqlite3 CLI.
  }
  if (sqlite?.DatabaseSync) {
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(SUMMARIES_SQL).all();
    } finally {
      db.close();
    }
  }
  const { stdout } = await execFileAsync(
    process.env.CODEXMOBILE_SQLITE_BIN || 'sqlite3',
    ['-readonly', '-json', dbPath, SUMMARIES_SQL],
    { windowsHide: true, timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }
  );
  return JSON.parse(stdout || '[]');
}

export async function queryAgyConversationSummaries(dbPath = AGY_SUMMARIES_DB_PATH) {
  let signature;
  try {
    signature = await dbSignature(dbPath);
  } catch {
    return [];
  }
  const cached = summariesCacheByDb.get(dbPath);
  if (cached && cached.signature === signature) {
    return cached.rows;
  }

  try {
    const rawRows = await querySummariesRows(dbPath);
    const rows = (Array.isArray(rawRows) ? rawRows : [])
      .filter((row) => row?.conversation_id)
      .map((row) => {
        const workspaces = parseWorkspaceUris(row.workspace_uris);
        return {
          id: String(row.conversation_id),
          title: String(row.title || '').trim() || null,
          preview: String(row.preview || '').trim() || null,
          stepCount: Number(row.step_count) || 0,
          updatedAt: normalizeAgyTimestamp(row.last_modified_time) || normalizeAgyTimestamp(row.last_user_input_time),
          cwd: workspaces[0] || null,
          workspaces,
          status: String(row.status || '').trim() || null,
          source: String(row.source || '').trim() || 'agy'
        };
      });
    summariesCacheByDb.set(dbPath, { signature, rows });
    return rows;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('[agy-config] Failed to read conversation summaries:', error.message);
    }
    return [];
  }
}

export async function readAgyConfig({ dbPath = AGY_SUMMARIES_DB_PATH, cwd = process.cwd() } = {}) {
  const model = String((await liveEnv('CODEXMOBILE_AGY_MODEL')) || process.env.AGY_MODEL || DEFAULT_AGY_MODEL).trim() || DEFAULT_AGY_MODEL;
  const modelsRaw = await liveEnv('CODEXMOBILE_AGY_MODELS');
  const summaries = await queryAgyConversationSummaries(dbPath);
  const projects = new Map();

  for (const row of summaries) {
    for (const workspacePath of row.workspaces) {
      const key = process.platform === 'win32' ? workspacePath.toLowerCase() : workspacePath;
      if (!projects.has(key)) {
        projects.set(key, {
          path: workspacePath,
          trustLevel: 'trusted',
          updatedAt: row.updatedAt || null
        });
      }
    }
  }

  const resolvedCwd = path.resolve(cwd);
  const cwdKey = process.platform === 'win32' ? resolvedCwd.toLowerCase() : resolvedCwd;
  if (!projects.has(cwdKey)) {
    projects.set(cwdKey, { path: resolvedCwd, trustLevel: 'trusted', updatedAt: null });
  }

  return {
    provider: 'agy',
    model,
    resolvedModel: model,
    modelShort: shortAgyModelName(model),
    reasoningEffort: process.env.CODEXMOBILE_AGY_EFFORT || 'high',
    baseUrl: null,
    models: buildAgyModelList(modelsRaw, model),
    projects: [...projects.values()]
  };
}
