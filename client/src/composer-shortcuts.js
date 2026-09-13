export const SLASH_COMMANDS = [
  {
    id: 'image',
    token: '/image',
    aliases: ['/img', '/生成图片'],
    title: '生成图片',
    description: '本条消息强制走图片生成（forceImage flag）',
    action: 'force-image'
  },
  {
    id: 'plan',
    token: '/plan',
    aliases: ['/计划模式'],
    title: '计划模式',
    description: '本条消息走 collaborationMode=plan，只规划不改代码',
    action: 'plan-mode'
  },
  {
    id: 'status',
    token: '/状态',
    aliases: ['/status'],
    title: '状态',
    description: '查看上下文、额度和连接状态',
    action: 'open-context'
  },
  {
    id: 'compact',
    token: '/压缩上下文',
    aliases: ['/compact'],
    title: '压缩上下文',
    description: '把旧上下文压缩成摘要，下次继续时线程更轻量',
    action: 'compact'
  },
  {
    id: 'review',
    token: '/代码审查',
    aliases: ['/review'],
    title: '代码审查',
    description: '勾选 code-reviewer skill（未装时退回提示文本）',
    action: 'select-skill',
    skillName: 'code-reviewer',
    fallbackPrompt: '请以代码审查视角检查当前仓库改动，优先指出 bug、行为回归、风险和缺失测试，并给出具体文件位置。'
  },
  {
    id: 'subagents',
    token: '/子代理',
    aliases: ['/subagents'],
    title: '子代理',
    description: '提示 Codex 在适合时拆分并行任务（提示文本）',
    action: 'insert-prompt',
    prompt: '如果任务适合拆分，请使用子代理并行处理互不冲突的部分，然后汇总结果。'
  }
];

export function detectComposerToken(text, cursor = null) {
  const value = String(text || '');
  const end = Number.isInteger(cursor) ? Math.max(0, Math.min(cursor, value.length)) : value.length;
  const before = value.slice(0, end);
  const match = before.match(/(^|\s)([/@$#])([^\s/@$#]*)$/u);
  if (!match) {
    return null;
  }
  const marker = match[2];
  const query = match[3] || '';
  const markerIndex = end - marker.length - query.length;
  const type = marker === '/' ? 'slash'
    : marker === '$' ? 'skill'
    : marker === '#' ? 'quick-prompt'
    : 'file';
  return {
    type,
    marker,
    query,
    start: markerIndex,
    end
  };
}

export function replaceComposerToken(text, token, replacement) {
  if (!token) {
    return String(text || '');
  }
  const value = String(text || '');
  const next = `${value.slice(0, token.start)}${replacement}${value.slice(token.end)}`;
  return next.replace(/[ \t]{2,}/g, ' ');
}

const MAX_SLASH_MATCHES = 8;

// A command's token + aliases, lowercased — the keys it matches on.
function lowerTokens(command) {
  return [command.token, ...(command.aliases || [])]
    .filter(Boolean)
    .map((token) => String(token).toLowerCase());
}

// Rank candidates so the picker stays short and predictable:
//   0 = exact token / alias match
//   1 = token / alias starts with the query (the common case — user is mid-typing)
//   2 = token / alias contains the query (substring fallback)
//   3 = title or description contains the query (last-resort fuzzy hit)
// Returning -1 means "drop entirely". Top MAX_SLASH_MATCHES survive sorted by
// score, then by token length (shorter tokens are usually what the user wants
// when typing a prefix).
function scoreSlashMatch(command, normalized) {
  let best = Infinity;
  for (const token of lowerTokens(command)) {
    if (token === normalized || token === `/${normalized}`) return 0;
    if (token.startsWith(normalized) || token.startsWith(`/${normalized}`)) {
      best = Math.min(best, 1);
    } else if (token.includes(normalized)) {
      best = Math.min(best, 2);
    }
  }
  if (best === Infinity) {
    const text = `${command.title || ''}\n${command.description || ''}`.toLowerCase();
    return text.includes(normalized) ? 3 : -1;
  }
  return best;
}

export function filteredSlashCommands(query, commands = SLASH_COMMANDS) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) {
    return commands.slice(0, MAX_SLASH_MATCHES);
  }
  const scored = [];
  for (const command of commands) {
    const score = scoreSlashMatch(command, normalized);
    if (score === -1) continue;
    scored.push({ command, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return String(a.command.token || '').length - String(b.command.token || '').length;
  });
  return scored.slice(0, MAX_SLASH_MATCHES).map(({ command }) => command);
}

// Build the picker list for the claude route: union of local macros + CLI-
// discovered commands (built-in + ~/.claude/commands + project commands).
// Whenever a local entry's token or alias collides with a CLI token, the
// local one is dropped — the CLI version is preferred ("效果更好"). Result is
// sorted so CLI command groups stay together (the source field decides bucket
// order) and titles within a bucket are alphabetical.
export function mergeSlashCommandsForClaude(localCommands, cliCommands) {
  const local = Array.isArray(localCommands) ? localCommands : [];
  const cli = Array.isArray(cliCommands) ? cliCommands : [];
  const cliTokens = new Set(cli.map((entry) => String(entry.token || '').toLowerCase()));
  const survivingLocal = local.filter(
    (command) => !lowerTokens(command).some((token) => cliTokens.has(token))
  );
  const bucket = (source) => {
    if (source === 'project') return 0;
    if (source === 'user') return 1;
    if (source === 'builtin') return 2;
    return 3; // local macros last
  };
  return [...survivingLocal.map((entry) => ({ ...entry, source: entry.source || 'macro' })), ...cli]
    .sort((a, b) => {
      const delta = bucket(a.source) - bucket(b.source);
      if (delta !== 0) return delta;
      return String(a.token || '').localeCompare(String(b.token || ''));
    });
}

export function filteredSkillsForToken(query, skills = []) {
  const list = Array.isArray(skills) ? skills : [];
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) return list;
  return list.filter((skill) => {
    const haystack = `${skill?.name || ''}\n${skill?.description || ''}`.toLowerCase();
    return haystack.includes(normalized);
  });
}
