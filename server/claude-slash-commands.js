// Enumerates slash commands available to a `claude -p` invocation:
//   - hard-coded list of CLI built-ins (curated; CLI doesn't expose this list
//     itself, so it has to be kept in sync with the claude-code release notes)
//   - user-level commands at ~/.claude/commands/**/*.md
//   - project-level commands at <projectRoot>/.claude/commands/**/*.md
//   - user-level skills at ~/.claude/skills/*/SKILL.md (surfaced as /<name>)
//   - project-level skills at <projectRoot>/.claude/skills/*/SKILL.md
//
// Sub-directories under commands/ become a namespace prefix:
// ~/.claude/commands/deepseek/rescue.md surfaces as `/deepseek:rescue`
// (mirrors how claude-code itself addresses nested commands). Frontmatter
// `description` is preferred for the light hint; otherwise we fall back to
// the first non-empty body line.
//
// Plugins (~/.claude/plugins/cache/...) are intentionally NOT scanned — the
// enabled set lives in plugins/installed_plugins.json with a non-trivial
// schema and stale cache paths, so the cost outweighs the value until users
// ask. The picker shows built-ins + user/project commands + user/project
// skills, which is the bulk of what people actually invoke from mobile.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { discoverSkillsFromDirs, parseSkillFrontmatter } from './skill-discovery.js';

// Curated built-in list. Kept short on description (mobile picker is narrow)
// and hint-style: what does the user expect to follow the slash. `hint` shows
// in the picker subline only when description is empty.
export const CLAUDE_BUILTIN_SLASH_COMMANDS = [
  { token: '/help', description: '查看 Claude CLI 命令帮助' },
  { token: '/clear', description: '清空当前会话上下文' },
  { token: '/compact', description: 'CLI 自带的上下文压缩（可附保留重点）' },
  { token: '/simplify', description: '让 Claude 简化当前任务/上下文' },
  { token: '/cost', description: '查看本会话累计 token 与费用' },
  { token: '/model', description: '切换当前会话使用的模型' },
  { token: '/permissions', description: '查看/调整工具权限' },
  { token: '/memory', description: '编辑 CLAUDE.md / 记忆条目' },
  { token: '/config', description: '查看/修改 CLI 配置项' },
  { token: '/status', description: 'CLI 端的状态汇总' },
  { token: '/agents', description: '管理子代理（subagent）' },
  { token: '/init', description: '为当前仓库生成 CLAUDE.md' },
  { token: '/review', description: '让 Claude 复审最近改动' },
  { token: '/security-review', description: '安全视角复审改动' },
  { token: '/bug', description: '上报 Claude CLI bug' },
  { token: '/release-notes', description: '查看最新版本说明' },
  { token: '/upgrade', description: '升级 Claude CLI' },
  { token: '/migrate-installer', description: '迁移到新版安装方式' },
  { token: '/mcp', description: '查看/管理 MCP 服务' },
  { token: '/hooks', description: '查看/调试 hook' },
  { token: '/pr-comments', description: '拉取当前 PR 的评论' },
  { token: '/add-dir', description: '把额外目录加入 Claude 可访问范围' },
  { token: '/loop', description: '把当前提示或 slash 命令按间隔重复执行' },
  { token: '/schedule', description: '创建/查看定时跑的远端 routine（cron）' },
  { token: '/update-config', description: '改 settings.json（权限/钩子/环境变量等）' },
  { token: '/keybindings-help', description: '查看/自定义 CLI 键位绑定' },
  { token: '/fewer-permission-prompts', description: '从最近会话总结安全 allowlist' },
  { token: '/claude-api', description: 'Anthropic SDK / Claude API 集成助手' }
];

function tokenToId(token, prefix) {
  const stripped = String(token || '').replace(/^\//, '');
  return `${prefix}:${stripped}`;
}

function tokenToTitle(token) {
  return String(token || '').replace(/^\//, '');
}

function firstBodyLine(content) {
  const text = String(content || '');
  const stripped = text.replace(/^﻿/, '');
  // Skip optional frontmatter block.
  const lines = stripped.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  if (i < lines.length && lines[i].trim() === '---') {
    i += 1;
    while (i < lines.length && lines[i].trim() !== '---') i += 1;
    if (i < lines.length) i += 1;
  }
  for (; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    return line.length > 120 ? `${line.slice(0, 117)}…` : line;
  }
  return '';
}

function buildEntry({ token, description, source, hint = '' }) {
  return {
    id: tokenToId(token, source),
    token,
    title: tokenToTitle(token),
    description: description || hint || '',
    source,
    action: 'cli-passthrough'
  };
}

export async function scanCommandsDir(rootDir, source) {
  if (!rootDir) return [];
  const results = [];
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, prefix ? `${prefix}:${entry.name}` : entry.name);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!entry.name.endsWith('.md')) continue;
      const base = entry.name.slice(0, -3);
      if (base === 'README') continue;
      const name = prefix ? `${prefix}:${base}` : base;
      let raw = '';
      try {
        raw = await fs.readFile(full, 'utf8');
      } catch {
        continue;
      }
      const frontmatter = parseSkillFrontmatter(raw);
      results.push(buildEntry({
        token: `/${name}`,
        description: frontmatter.description,
        hint: frontmatter.description ? '' : firstBodyLine(raw),
        source
      }));
    }
  }
  await walk(rootDir, '');
  return results;
}

export async function scanSkillsDir(rootDir, source) {
  if (!rootDir) return [];
  const skills = await discoverSkillsFromDirs([{ path: rootDir, source }]);
  return skills.map((skill) =>
    buildEntry({
      token: `/${skill.name}`,
      description: skill.description,
      source
    })
  );
}

const cache = new Map();
const CACHE_TTL_MS = 30_000;

export async function getClaudeSlashCommands({ projectRoot = null, force = false } = {}) {
  const key = projectRoot || '__no_project__';
  const cached = cache.get(key);
  const now = Date.now();
  if (!force && cached && now - cached.loadedAt < CACHE_TTL_MS) {
    return cached.commands;
  }
  const builtins = CLAUDE_BUILTIN_SLASH_COMMANDS.map((entry) =>
    buildEntry({ token: entry.token, description: entry.description, source: 'builtin' })
  );
  const home = os.homedir();
  // The four dir scans are independent — run them concurrently (cache-miss path).
  const [userCommands, userSkills, projectCommands, projectSkills] = await Promise.all([
    scanCommandsDir(path.join(home, '.claude', 'commands'), 'user'),
    scanSkillsDir(path.join(home, '.claude', 'skills'), 'user-skill'),
    projectRoot ? scanCommandsDir(path.join(projectRoot, '.claude', 'commands'), 'project') : [],
    projectRoot ? scanSkillsDir(path.join(projectRoot, '.claude', 'skills'), 'project-skill') : []
  ]);

  // De-dupe by token via Map.set "later wins". Precedence order:
  //   user-skill → builtin → user-command → project-skill → project-command.
  // Builtins beat user skills so a skill named e.g. `init` cannot shadow the
  // CLI's own `/init`; explicit command files still beat skills; project
  // overrides user (mirroring claude-code's own conflict resolution).
  const seen = new Map();
  for (const entry of [...userSkills, ...builtins, ...userCommands, ...projectSkills, ...projectCommands]) {
    seen.set(entry.token, entry);
  }

  const commands = [...seen.values()].sort((a, b) => a.token.localeCompare(b.token));
  cache.set(key, { commands, loadedAt: now });
  return commands;
}

export function clearClaudeSlashCommandCache() {
  cache.clear();
}
