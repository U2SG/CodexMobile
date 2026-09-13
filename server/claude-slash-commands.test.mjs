// Scanner + merge contract for the Claude slash-command catalog.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CLAUDE_BUILTIN_SLASH_COMMANDS,
  clearClaudeSlashCommandCache,
  getClaudeSlashCommands,
  scanCommandsDir,
  scanSkillsDir
} from './claude-slash-commands.js';

async function makeTempRoot(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return dir;
}

test('scanCommandsDir parses frontmatter description into hint', async () => {
  const root = await makeTempRoot('codexmobile-slash-');
  await fs.writeFile(
    path.join(root, 'foo.md'),
    '---\nname: foo\ndescription: Pretty foo\n---\nbody\n',
    'utf8'
  );
  const entries = await scanCommandsDir(root, 'user');
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    id: 'user:foo',
    token: '/foo',
    title: 'foo',
    description: 'Pretty foo',
    source: 'user',
    action: 'cli-passthrough'
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('scanCommandsDir nests subdirs as `:`-separated namespaces', async () => {
  const root = await makeTempRoot('codexmobile-slash-');
  await fs.mkdir(path.join(root, 'deepseek'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'deepseek', 'rescue.md'),
    '# Heading\n\nBody first line for hint\n',
    'utf8'
  );
  const entries = await scanCommandsDir(root, 'user');
  assert.equal(entries[0].token, '/deepseek:rescue');
  assert.equal(entries[0].title, 'deepseek:rescue');
  // No frontmatter present → first non-heading body line becomes hint.
  assert.equal(entries[0].description, 'Body first line for hint');
  await fs.rm(root, { recursive: true, force: true });
});

test('scanCommandsDir skips README.md and missing dirs', async () => {
  const empty = await scanCommandsDir('/no/such/dir', 'user');
  assert.deepEqual(empty, []);

  const root = await makeTempRoot('codexmobile-slash-');
  await fs.writeFile(path.join(root, 'README.md'), '# index\n', 'utf8');
  await fs.writeFile(path.join(root, 'real.md'), '---\ndescription: r\n---\n', 'utf8');
  const entries = await scanCommandsDir(root, 'user');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].token, '/real');
  await fs.rm(root, { recursive: true, force: true });
});

test('getClaudeSlashCommands merges builtin + user + project with project precedence', async () => {
  clearClaudeSlashCommandCache();
  const projectRoot = await makeTempRoot('codexmobile-proj-');
  const cmdDir = path.join(projectRoot, '.claude', 'commands');
  await fs.mkdir(cmdDir, { recursive: true });
  // Override the builtin /init with a project-level command of the same token.
  await fs.writeFile(
    path.join(cmdDir, 'init.md'),
    '---\ndescription: project-specific init\n---\n',
    'utf8'
  );

  const commands = await getClaudeSlashCommands({ projectRoot });
  const init = commands.find((c) => c.token === '/init');
  assert.ok(init, 'expected /init in merged list');
  assert.equal(init.source, 'project', 'project entry should win over builtin /init');
  assert.equal(init.description, 'project-specific init');

  // Builtins still present for non-overlapping tokens.
  assert.ok(commands.some((c) => c.token === '/simplify' && c.source === 'builtin'));
  await fs.rm(projectRoot, { recursive: true, force: true });
});

test('scanSkillsDir turns ~/.claude/skills/<name>/SKILL.md into /<name> entries', async () => {
  const root = await makeTempRoot('codexmobile-skills-');
  const skillDir = path.join(root, 'html-anything');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: html-anything\ndescription: Render content as HTML\n---\nbody\n',
    'utf8'
  );
  const entries = await scanSkillsDir(root, 'user-skill');
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    id: 'user-skill:html-anything',
    token: '/html-anything',
    title: 'html-anything',
    description: 'Render content as HTML',
    source: 'user-skill',
    action: 'cli-passthrough'
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('scanSkillsDir falls back to directory name when frontmatter omits name', async () => {
  const root = await makeTempRoot('codexmobile-skills-');
  const skillDir = path.join(root, 'save-state');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\ndescription: snapshot it\n---\n', 'utf8');
  const entries = await scanSkillsDir(root, 'user-skill');
  assert.equal(entries[0].token, '/save-state');
  assert.equal(entries[0].description, 'snapshot it');
  await fs.rm(root, { recursive: true, force: true });
});

test('scanSkillsDir returns [] for a missing dir', async () => {
  const empty = await scanSkillsDir('/no/such/skills/dir', 'user-skill');
  assert.deepEqual(empty, []);
});

test('getClaudeSlashCommands surfaces user skills alongside builtins', async () => {
  clearClaudeSlashCommandCache();
  // Stub HOME so the real ~/.claude/skills doesn't leak into the assertion.
  const fakeHome = await makeTempRoot('codexmobile-home-');
  const skillDir = path.join(fakeHome, '.claude', 'skills', 'html-anything');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: html-anything\ndescription: html it\n---\n',
    'utf8'
  );
  const origHome = process.env.HOME;
  const origUserprofile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const commands = await getClaudeSlashCommands({ force: true });
    const skill = commands.find((c) => c.token === '/html-anything');
    assert.ok(skill, 'expected /html-anything in merged list');
    assert.equal(skill.source, 'user-skill');
    assert.equal(skill.description, 'html it');
    assert.ok(commands.some((c) => c.token === '/help' && c.source === 'builtin'));
  } finally {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origUserprofile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserprofile;
    clearClaudeSlashCommandCache();
    await fs.rm(fakeHome, { recursive: true, force: true });
  }
});

test('getClaudeSlashCommands: project command overrides user skill of the same token', async () => {
  clearClaudeSlashCommandCache();
  const fakeHome = await makeTempRoot('codexmobile-home-');
  const skillDir = path.join(fakeHome, '.claude', 'skills', 'foo');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: foo\ndescription: from skill\n---\n',
    'utf8'
  );

  const projectRoot = await makeTempRoot('codexmobile-proj-');
  const cmdDir = path.join(projectRoot, '.claude', 'commands');
  await fs.mkdir(cmdDir, { recursive: true });
  await fs.writeFile(
    path.join(cmdDir, 'foo.md'),
    '---\ndescription: from project command\n---\n',
    'utf8'
  );

  const origHome = process.env.HOME;
  const origUserprofile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const commands = await getClaudeSlashCommands({ projectRoot, force: true });
    const foo = commands.find((c) => c.token === '/foo');
    assert.ok(foo);
    assert.equal(foo.source, 'project', 'project command must win over user-skill');
    assert.equal(foo.description, 'from project command');
  } finally {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origUserprofile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserprofile;
    clearClaudeSlashCommandCache();
    await fs.rm(fakeHome, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test('getClaudeSlashCommands: builtin beats user skill of the same token', async () => {
  clearClaudeSlashCommandCache();
  const fakeHome = await makeTempRoot('codexmobile-home-');
  // A user skill named `init` would otherwise shadow the builtin /init.
  const skillDir = path.join(fakeHome, '.claude', 'skills', 'init');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: init\ndescription: skill init\n---\n',
    'utf8'
  );
  const origHome = process.env.HOME;
  const origUserprofile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const commands = await getClaudeSlashCommands({ force: true });
    const init = commands.find((c) => c.token === '/init');
    assert.ok(init);
    assert.equal(init.source, 'builtin', 'builtin /init must win over user-skill of the same name');
  } finally {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origUserprofile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserprofile;
    clearClaudeSlashCommandCache();
    await fs.rm(fakeHome, { recursive: true, force: true });
  }
});

test('CLAUDE_BUILTIN_SLASH_COMMANDS includes /simplify and /help', () => {
  const tokens = new Set(CLAUDE_BUILTIN_SLASH_COMMANDS.map((c) => c.token));
  assert.ok(tokens.has('/simplify'));
  assert.ok(tokens.has('/help'));
  assert.ok(tokens.has('/compact'));
});
