import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseSkillFrontmatter,
  discoverSkillsFromDirs,
  defaultSkillRoots
} from './skill-discovery.js';

test('parseSkillFrontmatter extracts name + description from yaml frontmatter', () => {
  const body = [
    '---',
    'name: code-reviewer',
    'description: Review code for correctness and style.',
    '---',
    '',
    '# Code Reviewer'
  ].join('\n');
  const result = parseSkillFrontmatter(body);
  assert.equal(result.name, 'code-reviewer');
  assert.equal(result.description, 'Review code for correctness and style.');
});

test('parseSkillFrontmatter handles multi-line indented description', () => {
  const body = [
    '---',
    'name: long-skill',
    'description:',
    '  Line one of the description.',
    '  Line two continues here.',
    '---',
    '',
    'body'
  ].join('\n');
  const result = parseSkillFrontmatter(body);
  assert.equal(result.name, 'long-skill');
  assert.match(result.description, /Line one of the description/);
  assert.match(result.description, /Line two continues here/);
});

test('parseSkillFrontmatter strips surrounding quotes', () => {
  const body = [
    '---',
    'name: "quoted-skill"',
    "description: 'Quoted desc.'",
    '---'
  ].join('\n');
  const result = parseSkillFrontmatter(body);
  assert.equal(result.name, 'quoted-skill');
  assert.equal(result.description, 'Quoted desc.');
});

test('parseSkillFrontmatter returns empty fields when no frontmatter present', () => {
  const result = parseSkillFrontmatter('# Just a heading\n\nNo frontmatter here.');
  assert.equal(result.name, '');
  assert.equal(result.description, '');
});

test('parseSkillFrontmatter tolerates leading whitespace and CRLF newlines', () => {
  const body = '\r\n---\r\nname: crlf-skill\r\ndescription: ok\r\n---\r\n';
  const result = parseSkillFrontmatter(body);
  assert.equal(result.name, 'crlf-skill');
  assert.equal(result.description, 'ok');
});

async function withTempSkillTree(layout) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-discovery-'));
  for (const [skillName, files] of Object.entries(layout)) {
    const dir = path.join(root, skillName);
    await fs.mkdir(dir, { recursive: true });
    for (const [fileName, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, fileName), content, 'utf8');
    }
  }
  return root;
}

test('discoverSkillsFromDirs scans SKILL.md across multiple roots and tags source', async () => {
  const root1 = await withTempSkillTree({
    'alpha': {
      'SKILL.md': '---\nname: alpha\ndescription: First skill.\n---\n\nBody alpha.'
    },
    'beta': {
      'SKILL.md': '---\nname: beta\ndescription: Second skill.\n---\n\nBody beta.'
    }
  });
  const root2 = await withTempSkillTree({
    'gamma': {
      'SKILL.md': '---\nname: gamma\ndescription: Repo skill.\n---\n\nRepo body.'
    }
  });

  const skills = await discoverSkillsFromDirs([
    { path: root1, source: 'claude' },
    { path: root2, source: 'repo' }
  ]);

  const names = skills.map((s) => s.name).sort();
  assert.deepEqual(names, ['alpha', 'beta', 'gamma']);

  const alpha = skills.find((s) => s.name === 'alpha');
  assert.equal(alpha.source, 'claude');
  assert.equal(alpha.description, 'First skill.');
  assert.equal(path.basename(alpha.path), 'SKILL.md');

  const gamma = skills.find((s) => s.name === 'gamma');
  assert.equal(gamma.source, 'repo');
});

test('discoverSkillsFromDirs skips subdirs without SKILL.md silently', async () => {
  const root = await withTempSkillTree({
    'has-skill': { 'SKILL.md': '---\nname: has-skill\n---\n' },
    'no-skill': { 'README.md': 'no skill file here' }
  });
  const skills = await discoverSkillsFromDirs([{ path: root, source: 'claude' }]);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'has-skill');
});

test('discoverSkillsFromDirs falls back to directory name when frontmatter missing', async () => {
  const root = await withTempSkillTree({
    'bare-skill': { 'SKILL.md': '# Bare skill, no frontmatter' }
  });
  const skills = await discoverSkillsFromDirs([{ path: root, source: 'claude' }]);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'bare-skill');
  assert.equal(skills[0].description, '');
});

test('discoverSkillsFromDirs follows symlinked skill directories', async () => {
  // ~/.claude/skills frequently contains symlinks to a central skill repo;
  // dropping symlinks here meant > half the user's installed skills never
  // reached the picker. Lock in the symlink path so a future "tighten the
  // filesystem checks" refactor cannot regress to the dirent-only branch.
  const realRoot = await withTempSkillTree({
    'real-skill': { 'SKILL.md': '---\nname: real-skill\n---\n' }
  });
  const skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-symlink-root-'));
  try {
    await fs.symlink(path.join(realRoot, 'real-skill'), path.join(skillsRoot, 'linked-skill'), 'dir');
  } catch (error) {
    // Windows without symlink privilege — skip rather than fail.
    if (error.code === 'EPERM' || error.code === 'EACCES') return;
    throw error;
  }
  const skills = await discoverSkillsFromDirs([{ path: skillsRoot, source: 'claude' }]);
  assert.equal(skills.length, 1, 'symlinked skill should be discovered');
  assert.equal(skills[0].name, 'real-skill');
});

test('discoverSkillsFromDirs returns empty array when no root exists', async () => {
  const skills = await discoverSkillsFromDirs([
    { path: path.join(os.tmpdir(), 'definitely-does-not-exist-skill-' + Date.now()), source: 'claude' }
  ]);
  assert.deepEqual(skills, []);
});

test('defaultSkillRoots in claude mode covers only ~/.claude/skills', () => {
  const roots = defaultSkillRoots({ agent: 'claude', repoSkillsDir: '/repo/skills' });
  const sources = roots.map((r) => r.source);
  assert.ok(sources.includes('claude'), 'claude mode should include ~/.claude/skills');
  assert.equal(sources.includes('repo'), false, 'claude mode must not include codex-only repo skills');
  assert.equal(sources.includes('codex'), false, 'claude mode must not include ~/.codex/skills');
});

test('defaultSkillRoots in codex mode covers ~/.codex/skills + repo skills', () => {
  const roots = defaultSkillRoots({ agent: 'codex', repoSkillsDir: '/repo/skills' });
  const sources = roots.map((r) => r.source);
  assert.ok(sources.includes('codex'), 'codex mode should include ~/.codex/skills probe');
  assert.ok(sources.includes('repo'), 'codex mode should include in-repo skills');
  assert.equal(sources.includes('claude'), false, 'codex mode must not include ~/.claude/skills');
});

test('defaultSkillRoots omits repo root when repoSkillsDir is not provided', () => {
  const roots = defaultSkillRoots({ agent: 'codex' });
  const sources = roots.map((r) => r.source);
  assert.equal(sources.includes('repo'), false);
});

test('discoverSkillsFromDirs sorts results by name for stable client rendering', async () => {
  const root = await withTempSkillTree({
    'zeta': { 'SKILL.md': '---\nname: zeta\n---\n' },
    'alpha': { 'SKILL.md': '---\nname: alpha\n---\n' },
    'mu': { 'SKILL.md': '---\nname: mu\n---\n' }
  });
  const skills = await discoverSkillsFromDirs([{ path: root, source: 'claude' }]);
  assert.deepEqual(skills.map((s) => s.name), ['alpha', 'mu', 'zeta']);
});
