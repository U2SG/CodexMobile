// Discovers Claude / repo skills by scanning candidate roots for SKILL.md
// files and parsing the optional YAML frontmatter at the top.
//
// Mobile and desktop clients use the returned list to populate the skill
// picker; chat-request-prep.js uses it as the allowlist for normalizing
// the selected skills the client sends back.
//
// We hand-parse the frontmatter (just `name` and `description`) instead
// of pulling in a YAML dependency — Claude skill frontmatter is shallow
// and stays that way. Anything fancier falls back to the directory name
// + empty description.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function stripQuotes(value) {
  const trimmed = String(value || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseSkillFrontmatter(content) {
  const text = String(content || '').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  let cursor = 0;
  while (cursor < lines.length && lines[cursor].trim() === '') cursor += 1;
  if (cursor >= lines.length || lines[cursor].trim() !== '---') {
    return { name: '', description: '' };
  }
  cursor += 1;

  const fields = new Map();
  let activeKey = null;
  let activeIndent = -1;
  let activeMultilineLines = null;

  function flushMultiline() {
    if (activeKey && activeMultilineLines) {
      fields.set(activeKey, activeMultilineLines.join(' ').trim());
    }
    activeKey = null;
    activeIndent = -1;
    activeMultilineLines = null;
  }

  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.trim() === '---') {
      flushMultiline();
      break;
    }
    const indent = line.match(/^\s*/)[0].length;
    const match = line.match(/^(\s*)([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
    if (match && indent <= activeIndent) {
      flushMultiline();
    }
    if (match && activeMultilineLines === null) {
      const key = match[2];
      const value = match[3];
      if (value === '') {
        activeKey = key;
        activeIndent = indent;
        activeMultilineLines = [];
      } else {
        fields.set(key, stripQuotes(value));
        activeKey = null;
        activeIndent = -1;
        activeMultilineLines = null;
      }
      continue;
    }
    if (activeMultilineLines !== null && indent > activeIndent && line.trim() !== '') {
      activeMultilineLines.push(line.trim());
      continue;
    }
    if (line.trim() === '') continue;
    flushMultiline();
  }

  return {
    name: fields.get('name') || '',
    description: fields.get('description') || ''
  };
}

async function readSkillEntry(skillDir, source) {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  let raw;
  try {
    raw = await fs.readFile(skillMdPath, 'utf8');
  } catch {
    return null;
  }
  const frontmatter = parseSkillFrontmatter(raw);
  return {
    name: frontmatter.name || path.basename(skillDir),
    description: frontmatter.description || '',
    path: skillMdPath,
    source
  };
}

export async function discoverSkillsFromDirs(roots) {
  const results = [];
  for (const root of Array.isArray(roots) ? roots : []) {
    if (!root?.path) continue;
    let entries;
    try {
      entries = await fs.readdir(root.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Accept directories AND symlinks: ~/.claude/skills frequently contains
      // symlinks to skill repos so a Dirent.isDirectory() check alone drops
      // every linked skill. readSkillEntry will return null if the target
      // doesn't expose a readable SKILL.md, so non-dir symlinks fall through
      // harmlessly.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skill = await readSkillEntry(path.join(root.path, entry.name), root.source || 'unknown');
      if (skill) results.push(skill);
    }
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

// Skills are runtime-specific: Claude's skill files live under ~/.claude/skills
// and follow the Claude Skills frontmatter contract; codex picks up its skills
// from ~/.codex/skills plus repo-local skills/ (which today are codex-only
// Lark integrations bundled via feishu-skills.js). Mixing them in one picker
// confuses the user and lets claude turns reference repo skills that were
// never written for the claude prompt format. Filter by agent at the root
// list, not at render time.
export function defaultSkillRoots({ repoSkillsDir, agent = 'codex' } = {}) {
  const normalized = String(agent || '').trim().toLowerCase();
  if (normalized === 'claude' || normalized === 'claude-code') {
    return [{ path: path.join(os.homedir(), '.claude', 'skills'), source: 'claude' }];
  }
  const roots = [{ path: path.join(os.homedir(), '.codex', 'skills'), source: 'codex' }];
  if (repoSkillsDir) {
    roots.push({ path: repoSkillsDir, source: 'repo' });
  }
  return roots;
}

const cacheByAgent = new Map();
const CACHE_TTL_MS = 30_000;

export async function getAvailableSkills({ repoSkillsDir, agent = 'codex', force = false } = {}) {
  const key = String(agent || 'codex').toLowerCase();
  const cached = cacheByAgent.get(key);
  const now = Date.now();
  if (!force && cached && now - cached.loadedAt < CACHE_TTL_MS) {
    return cached.skills;
  }
  const skills = await discoverSkillsFromDirs(defaultSkillRoots({ repoSkillsDir, agent }));
  cacheByAgent.set(key, { skills, loadedAt: now });
  return skills;
}

export function clearSkillCache() {
  cacheByAgent.clear();
}
