import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { liveEnv } from './env-file.js';

export const CLAUDE_HOME = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
export const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
export const CLAUDE_HISTORY_PATH = path.join(CLAUDE_HOME, 'history.jsonl');

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE_MODEL_ALIAS_NAMES = new Set(['opus', 'sonnet', 'fable', 'haiku']);
const CLAUDE_MODEL_ALIAS_LABELS = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  fable: 'Fable',
  haiku: 'Haiku'
};

function claudeModelCachePath() {
  return process.env.CODEXMOBILE_CLAUDE_MODEL_CACHE || path.join(ROOT_DIR, '.codexmobile', 'state', 'claude-model-aliases.json');
}

async function readClaudeModelAliasCache() {
  try {
    const parsed = JSON.parse(await fs.readFile(claudeModelCachePath(), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.aliases && typeof parsed.aliases === 'object'
      ? parsed.aliases
      : {};
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[claude-config] Failed to read model alias cache:', error.message);
    }
    return {};
  }
}

function parseResolvedClaudeModel(model) {
  const value = String(model || '').trim();
  const match = value.match(/^claude-(opus|sonnet|fable|haiku)-(\d+)(?:-(\d+))?(?:-(\d{8}))?$/i);
  if (!match) return null;
  const alias = match[1].toLowerCase();
  const family = CLAUDE_MODEL_ALIAS_LABELS[alias] || titleCase(alias);
  const minor = match[3] && match[3].length < 8 ? match[3] : '';
  const version = minor ? `${match[2]}.${minor}` : match[2];
  return {
    alias,
    resolved: value,
    short: `${family} ${version}`,
    label: `Claude ${family} ${version}`
  };
}

let modelAliasWriteChain = Promise.resolve();

export async function recordClaudeResolvedModel(requestedModel, resolvedModel) {
  const alias = String(requestedModel || '').trim().toLowerCase();
  const parsed = parseResolvedClaudeModel(resolvedModel);
  if (!CLAUDE_MODEL_ALIAS_NAMES.has(alias) || !parsed || parsed.alias !== alias) {
    return false;
  }

  modelAliasWriteChain = modelAliasWriteChain.then(async () => {
    const aliases = await readClaudeModelAliasCache();
    if (aliases[alias]?.resolvedModel === parsed.resolved) return false;
    aliases[alias] = {
      resolvedModel: parsed.resolved,
      observedAt: new Date().toISOString()
    };
    const target = claudeModelCachePath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, aliases }, null, 2), 'utf8');
    await fs.rename(tmp, target);
    return true;
  }).catch((error) => {
    console.warn('[claude-config] Failed to persist resolved model alias:', error.message);
    return false;
  });

  return modelAliasWriteChain;
}

// Default dropdown contents. Native families use the bare alias so the CLI
// always resolves to the latest of that family (`fable` became a native alias
// too — see `claude --help`); anything outside them must be a full `claude-*`
// id so resolveClaudeModel passes it through verbatim. Override / extend via
// CODEXMOBILE_CLAUDE_MODELS — read live from .env on every cache refresh, so a
// model upgrade is a .env edit + a sync from the phone, no restart.
const DEFAULT_CLAUDE_MODELS = ['opus', 'sonnet', 'fable', 'haiku'];

function buildClaudeModelList(rawValue, aliasCache = {}) {
  const raw = String(rawValue || '').trim();
  const ids = raw
    ? raw.split(',').map((entry) => entry.trim()).filter(Boolean)
    : DEFAULT_CLAUDE_MODELS;
  const seen = new Set();
  const list = [];
  for (const id of ids) {
    const display = modelDisplay(id, aliasCache);
    if (seen.has(display.value)) {
      continue;
    }
    seen.add(display.value);
    list.push({ value: display.value, label: display.label, resolvedModel: display.resolved });
  }
  return list;
}

function titleCase(value) {
  return String(value || '').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function modelDisplay(model, aliasCache = {}) {
  const value = String(model || 'sonnet').trim() || 'sonnet';
  const aliasName = value.toLowerCase();
  if (CLAUDE_MODEL_ALIAS_NAMES.has(aliasName)) {
    const observed = parseResolvedClaudeModel(aliasCache?.[aliasName]?.resolvedModel);
    if (observed && observed.alias === aliasName) {
      return { value, resolved: observed.resolved, short: observed.short, label: observed.label };
    }
    const family = CLAUDE_MODEL_ALIAS_LABELS[aliasName] || titleCase(aliasName);
    return {
      value,
      resolved: null,
      short: family,
      label: `Claude ${family}`
    };
  }

  const parsed = parseResolvedClaudeModel(value);
  if (parsed) {
    return {
      value,
      resolved: parsed.resolved,
      short: parsed.short,
      label: parsed.label
    };
  }

  const label = titleCase(value.replace(/^claude-/i, '').replace(/-\d{8}$/i, '').replace(/-/g, ' '));
  return {
    value,
    resolved: value,
    short: label,
    label: value.startsWith('claude-') ? `Claude ${label}` : label
  };
}

async function readHistoryProjects() {
  const projects = new Map();
  try {
    const raw = await fs.readFile(CLAUDE_HISTORY_PATH, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line);
        if (entry.project && typeof entry.project === 'string') {
          projects.set(path.resolve(entry.project), {
            path: path.resolve(entry.project),
            trustLevel: 'trusted',
            updatedAt: entry.timestamp ? new Date(entry.timestamp).toISOString() : null
          });
        }
      } catch {
        // Ignore malformed history rows.
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[claude-config] Failed to read Claude history:', error.message);
    }
  }
  return [...projects.values()];
}

export async function readClaudeConfig() {
  const model = String((await liveEnv('CODEXMOBILE_CLAUDE_MODEL')) || process.env.CLAUDE_MODEL || 'sonnet').trim() || 'sonnet';
  const aliasCache = await readClaudeModelAliasCache();
  const display = modelDisplay(model, aliasCache);
  const projects = await readHistoryProjects();
  if (!projects.some((project) => path.resolve(project.path) === path.resolve(process.cwd()))) {
    projects.push({ path: process.cwd(), trustLevel: 'trusted', updatedAt: null });
  }

  return {
    provider: 'claude',
    model,
    resolvedModel: display.resolved,
    modelShort: display.short,
    reasoningEffort: process.env.CODEXMOBILE_CLAUDE_EFFORT || 'high',
    baseUrl: null,
    models: buildClaudeModelList(await liveEnv('CODEXMOBILE_CLAUDE_MODELS'), aliasCache),
    projects
  };
}
