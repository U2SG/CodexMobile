import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_LIMIT = 20;
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', '.codexmobile', 'client/dist']);

function normalizeQuery(value) {
  return String(value || '').trim().toLowerCase();
}

function isIgnoredRelativePath(relativePath) {
  const parts = String(relativePath || '').split(/[\\/]+/).filter(Boolean);
  return parts.some((part, index) => IGNORE_DIRS.has(part) || IGNORE_DIRS.has(parts.slice(0, index + 1).join('/')));
}

function fileMatchScore(relativePath, query) {
  const normalized = relativePath.toLowerCase();
  const base = path.basename(normalized);
  if (!query) {
    return 100;
  }
  if (base === query) {
    return 0;
  }
  if (base.startsWith(query)) {
    return 5;
  }
  if (base.includes(query)) {
    return 15;
  }
  if (normalized.startsWith(query)) {
    return 25;
  }
  if (normalized.includes(query)) {
    return 40;
  }
  return Number.POSITIVE_INFINITY;
}

function toSearchResult(root, relativePath) {
  const cleanRelative = relativePath.replace(/\\/g, '/');
  return {
    name: path.basename(cleanRelative),
    path: path.join(root, cleanRelative),
    relativePath: cleanRelative
  };
}

async function listFilesWithRg(root) {
  const { stdout } = await execFileAsync('rg', ['--files', '--hidden'], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

// .gitignore parser used only when rg is unavailable and we fall back to
// walking the tree ourselves. Supports the common patterns (`*.log`,
// `build/`, `secrets.env`, leading-`/` anchoring, `**`) but intentionally
// skips negation (`!foo`) and nested .gitignore — rg already covers the
// 100%-accurate case when it is on PATH, and the fallback only needs to
// keep the @file-mention picker free of obvious noise.
function parseGitignore(content) {
  const rules = [];
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const trimmed = rawLine.replace(/^\s+|\s+$/g, '');
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('!')) continue;
    let pattern = trimmed;
    const directoryOnly = pattern.endsWith('/');
    if (directoryOnly) pattern = pattern.slice(0, -1);
    let anchored = pattern.startsWith('/');
    if (anchored) pattern = pattern.slice(1);
    else if (pattern.includes('/')) anchored = true;
    rules.push({ regex: gitignoreToRegex(pattern), directoryOnly, anchored });
  }
  return rules;
}

function gitignoreToRegex(pattern) {
  let body = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      body += '.*';
      i += 1;
      if (pattern[i + 1] === '/') i += 1;
    } else if (c === '*') {
      body += '[^/]*';
    } else if (c === '?') {
      body += '[^/]';
    } else if ('.+()^$|{}[]\\'.includes(c)) {
      body += `\\${c}`;
    } else {
      body += c;
    }
  }
  return new RegExp(`^${body}$`);
}

function gitignoreMatches(rules, relativePath, isDir) {
  if (!rules.length) return false;
  const segments = relativePath.split('/').filter(Boolean);
  const basename = segments[segments.length - 1] || '';
  for (const rule of rules) {
    if (rule.directoryOnly && !isDir) continue;
    if (rule.anchored) {
      if (rule.regex.test(relativePath)) return true;
    } else {
      if (rule.regex.test(basename)) return true;
      // Unanchored patterns match against any intermediate directory segment
      // so `build` excludes everything under `build/`, `nested/build/` etc.
      const segmentLimit = isDir ? segments.length : segments.length - 1;
      for (let i = 0; i < segmentLimit; i += 1) {
        if (rule.regex.test(segments[i])) return true;
      }
    }
  }
  return false;
}

async function loadRootGitignoreRules(root) {
  try {
    const content = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    return parseGitignore(content);
  } catch {
    return [];
  }
}

async function listFilesWithFs(root) {
  const rules = await loadRootGitignoreRules(root);
  const results = [];
  await walkForFs(root, root, rules, results);
  return results;
}

async function walkForFs(root, current, rules, results) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
    if (isIgnoredRelativePath(relativePath)) continue;
    const isDir = entry.isDirectory();
    if (gitignoreMatches(rules, relativePath, isDir)) continue;
    if (isDir) {
      await walkForFs(root, fullPath, rules, results);
    } else if (entry.isFile()) {
      results.push(relativePath);
    }
  }
  return results;
}

export async function searchProjectFiles(project, query, { limit = DEFAULT_LIMIT } = {}) {
  const root = path.resolve(project?.path || '');
  if (!root || root === path.parse(root).root && !project?.path) {
    return [];
  }

  const normalizedQuery = normalizeQuery(query);
  let files = [];
  try {
    files = await listFilesWithRg(root);
  } catch {
    files = await listFilesWithFs(root);
  }

  return files
    .filter((file) => file && !isIgnoredRelativePath(file))
    .map((file) => ({ file, score: fileMatchScore(file, normalizedQuery) }))
    .filter((item) => item.score !== Number.POSITIVE_INFINITY)
    .sort((a, b) => a.score - b.score || a.file.length - b.file.length || a.file.localeCompare(b.file))
    .slice(0, Math.max(1, Number(limit) || DEFAULT_LIMIT))
    .map((item) => toSearchResult(root, item.file));
}

export const fileSearchInternals = {
  isIgnoredRelativePath,
  fileMatchScore,
  parseGitignore,
  gitignoreMatches,
  listFilesWithFs
};
