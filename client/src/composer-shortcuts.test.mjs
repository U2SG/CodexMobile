import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SLASH_COMMANDS,
  detectComposerToken,
  filteredSkillsForToken,
  filteredSlashCommands,
  mergeSlashCommandsForClaude,
  replaceComposerToken
} from './composer-shortcuts.js';

test('detectComposerToken finds slash, skill, file, and quick-prompt tokens', () => {
  assert.deepEqual(detectComposerToken('/rev', 4), {
    type: 'slash',
    marker: '/',
    query: 'rev',
    start: 0,
    end: 4
  });
  assert.deepEqual(detectComposerToken('请用 $frontend', 12), {
    type: 'skill',
    marker: '$',
    query: 'frontend',
    start: 3,
    end: 12
  });
  assert.deepEqual(detectComposerToken('看 @server', 9), {
    type: 'file',
    marker: '@',
    query: 'server',
    start: 2,
    end: 9
  });
  assert.deepEqual(detectComposerToken('#review', 7), {
    type: 'quick-prompt',
    marker: '#',
    query: 'review',
    start: 0,
    end: 7
  });
  assert.deepEqual(detectComposerToken('请帮我 #总结', 7), {
    type: 'quick-prompt',
    marker: '#',
    query: '总结',
    start: 4,
    end: 7
  });
});

test('replaceComposerToken removes selected skill token without leaking it into text', () => {
  const text = '请用 $frontend 优化';
  const token = detectComposerToken(text, 12);
  assert.equal(replaceComposerToken(text, token, ''), '请用 优化');
});

test('filteredSlashCommands matches Chinese commands and English aliases', () => {
  assert.equal(filteredSlashCommands('状态')[0].id, 'status');
  assert.equal(filteredSlashCommands('compact')[0].id, 'compact');
  assert.equal(filteredSlashCommands('review')[0].id, 'review');
});

test('filteredSlashCommands exposes plan mode as a native plan-mode action', () => {
  const command = filteredSlashCommands('plan')[0];
  assert.equal(command.id, 'plan');
  // Was insert-prompt with prompt '/plan' (server never parsed it).
  // Now drives body.collaborationMode = { mode: 'plan' } directly.
  assert.equal(command.action, 'plan-mode');
});

test('filteredSlashCommands exposes explicit image mode as a native force-image action', () => {
  const command = filteredSlashCommands('image')[0];
  assert.equal(command.id, 'image');
  // Was insert-prompt '/image'. Now drives body.forceImage = true directly.
  assert.equal(command.action, 'force-image');
});

test('filteredSkillsForToken returns full list when query is empty', () => {
  const skills = [
    { name: 'alpha', description: 'A' },
    { name: 'beta', description: 'B' }
  ];
  assert.equal(filteredSkillsForToken('', skills).length, 2);
});

test('filteredSkillsForToken matches name and description case-insensitively', () => {
  const skills = [
    { name: 'code-reviewer', description: 'Review code' },
    { name: 'planning-with-files', description: 'Plan before coding' }
  ];
  assert.equal(filteredSkillsForToken('REVIEW', skills)[0].name, 'code-reviewer');
  assert.equal(filteredSkillsForToken('plan', skills)[0].name, 'planning-with-files');
  assert.equal(filteredSkillsForToken('nonsense', skills).length, 0);
});

test('filteredSkillsForToken treats non-array input as empty', () => {
  assert.deepEqual(filteredSkillsForToken('x', null), []);
});

test('SLASH_COMMANDS /image binds to native force-image action, not text macro', () => {
  const cmd = filteredSlashCommands('image')[0];
  assert.equal(cmd.id, 'image');
  assert.equal(cmd.action, 'force-image');
});

test('SLASH_COMMANDS /plan binds to native plan-mode action, not text macro', () => {
  const cmd = filteredSlashCommands('plan')[0];
  assert.equal(cmd.id, 'plan');
  assert.equal(cmd.action, 'plan-mode');
});

test('SLASH_COMMANDS /代码审查 picks the code-reviewer skill, with prompt as fallback', () => {
  const cmd = filteredSlashCommands('review').find((c) => c.id === 'review');
  assert.equal(cmd.action, 'select-skill');
  assert.equal(cmd.skillName, 'code-reviewer');
  assert.ok(typeof cmd.fallbackPrompt === 'string' && cmd.fallbackPrompt.length > 0,
    'fallbackPrompt must remain for users without the skill');
});

test('SLASH_COMMANDS /子代理 stays a prompt-only macro (no native equivalent)', () => {
  const cmd = filteredSlashCommands('subagents')[0];
  assert.equal(cmd.id, 'subagents');
  assert.equal(cmd.action, 'insert-prompt');
});

test('filteredSlashCommands caps results at 8 and ranks token-prefix above substring above description', () => {
  const pool = [
    { id: 'a', token: '/simplify', description: 'fluff' },
    { id: 'b', token: '/status', description: 'fluff' },
    { id: 'c', token: '/security-review', description: 'fluff' },
    { id: 'd', token: '/agents', description: 'has letter s in it' },
    { id: 'e', token: '/help', description: 'something that mentions s' },
    { id: 'f', token: '/init', description: 'no relevant letters' },
    { id: 'g', token: '/sort', description: 'fluff' },
    { id: 'h', token: '/sniff', description: 'fluff' },
    { id: 'i', token: '/sleep', description: 'fluff' },
    { id: 'j', token: '/scan', description: 'fluff' }
  ];
  const out = filteredSlashCommands('s', pool);
  // Cap honored.
  assert.ok(out.length <= 8);
  // Token-prefix matches (start with /s) come first.
  const prefixMatches = out.filter((c) => c.token.toLowerCase().startsWith('/s'));
  assert.ok(prefixMatches.length >= 5, 'token-prefix matches should come first');
  // /init (only matches via description heuristic — no 's' in token) should NOT
  // squeeze ahead of token-prefix matches.
  const initIndex = out.findIndex((c) => c.id === 'f');
  const firstPrefixIndex = out.findIndex((c) => c.token.toLowerCase().startsWith('/s'));
  if (initIndex !== -1) assert.ok(initIndex > firstPrefixIndex);
});

test('mergeSlashCommandsForClaude drops local macros whose token or alias collides with a CLI entry', () => {
  const cli = [
    { id: 'builtin:compact', token: '/compact', title: 'compact', description: 'CLI compact', source: 'builtin', action: 'cli-passthrough' },
    { id: 'builtin:status', token: '/status', title: 'status', description: 'CLI status', source: 'builtin', action: 'cli-passthrough' },
    { id: 'builtin:review', token: '/review', title: 'review', description: 'CLI review', source: 'builtin', action: 'cli-passthrough' }
  ];
  const merged = mergeSlashCommandsForClaude(SLASH_COMMANDS, cli);
  // Local /压缩上下文 (alias /compact), /状态 (alias /status), /代码审查 (alias /review)
  // must be filtered — CLI is preferred when there is a conflict.
  assert.ok(!merged.some((c) => c.token === '/压缩上下文'), 'expected /压缩上下文 to be dropped (alias collides with /compact)');
  assert.ok(!merged.some((c) => c.token === '/状态'), 'expected /状态 to be dropped (alias collides with /status)');
  assert.ok(!merged.some((c) => c.token === '/代码审查'), 'expected /代码审查 to be dropped (alias collides with /review)');
  // Non-colliding local macros must survive.
  assert.ok(merged.some((c) => c.token === '/image'));
  assert.ok(merged.some((c) => c.token === '/plan'));
  assert.ok(merged.some((c) => c.token === '/子代理'));
  // CLI entries are present.
  for (const cmd of cli) assert.ok(merged.some((c) => c.token === cmd.token));
});

test('mergeSlashCommandsForClaude returns local list when no CLI commands are supplied', () => {
  const merged = mergeSlashCommandsForClaude(SLASH_COMMANDS, []);
  assert.equal(merged.length, SLASH_COMMANDS.length);
});

test('mergeSlashCommandsForClaude preserves cli-passthrough action and sorts project before user before builtin', () => {
  const cli = [
    { id: 'builtin:help', token: '/help', source: 'builtin', action: 'cli-passthrough' },
    { id: 'user:foo', token: '/foo', source: 'user', action: 'cli-passthrough' },
    { id: 'project:bar', token: '/bar', source: 'project', action: 'cli-passthrough' }
  ];
  const merged = mergeSlashCommandsForClaude([], cli);
  assert.equal(merged[0].source, 'project');
  assert.equal(merged[1].source, 'user');
  assert.equal(merged[2].source, 'builtin');
});
