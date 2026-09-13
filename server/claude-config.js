import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { liveEnv } from './env-file.js';

export const CLAUDE_HOME = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
export const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
export const CLAUDE_HISTORY_PATH = path.join(CLAUDE_HOME, 'history.jsonl');

// `resolved` mirrors what the CLI itself reports in the stream-json `init`
// event for that alias — display only, the alias is what gets spawned.
const CLAUDE_MODEL_ALIASES = {
  opus: { resolved: 'claude-opus-5', short: 'Opus 5', label: 'Claude Opus 5' },
  sonnet: { resolved: 'claude-sonnet-5', short: 'Sonnet 5', label: 'Claude Sonnet 5' },
  fable: { resolved: 'claude-fable-5', short: 'Fable 5', label: 'Claude Fable 5' },
  haiku: { resolved: 'claude-haiku-4-5-20251001', short: 'Haiku 4.5', label: 'Claude Haiku 4.5' }
};

// Default dropdown contents. Native families use the bare alias so the CLI
// always resolves to the latest of that family (`fable` became a native alias
// too — see `claude --help`); anything outside them must be a full `claude-*`
// id so resolveClaudeModel passes it through verbatim. Override / extend via
// CODEXMOBILE_CLAUDE_MODELS — read live from .env on every cache refresh, so a
// model upgrade is a .env edit + a sync from the phone, no restart.
const DEFAULT_CLAUDE_MODELS = ['opus', 'sonnet', 'fable', 'haiku'];

function buildClaudeModelList(rawValue) {
  const raw = String(rawValue || '').trim();
  const ids = raw
    ? raw.split(',').map((entry) => entry.trim()).filter(Boolean)
    : DEFAULT_CLAUDE_MODELS;
  const seen = new Set();
  const list = [];
  for (const id of ids) {
    const display = modelDisplay(id);
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

function modelDisplay(model) {
  const value = String(model || 'sonnet').trim() || 'sonnet';
  const alias = CLAUDE_MODEL_ALIASES[value.toLowerCase()];
  if (alias) {
    return { value, ...alias };
  }

  const match = value.match(/^claude-(sonnet|opus|haiku)-(\d+)-(\d+)/i);
  if (match) {
    const family = titleCase(match[1]);
    const version = `${match[2]}.${match[3]}`;
    return {
      value,
      resolved: value,
      short: `${family} ${version}`,
      label: `Claude ${family} ${version}`
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
  const display = modelDisplay(model);
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
    models: buildClaudeModelList(await liveEnv('CODEXMOBILE_CLAUDE_MODELS')),
    projects
  };
}
