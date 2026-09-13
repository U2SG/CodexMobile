import assert from 'node:assert/strict';
import test from 'node:test';
import {
  toggleSkill,
  isSkillSelected,
  selectedSkillsAsBodyEntries,
  filterSkillsByQuery
} from './skill-selection.js';

const ALPHA = { name: 'alpha', description: 'First skill', path: '/skills/alpha/SKILL.md', source: 'claude' };
const BETA = { name: 'beta', description: 'Second skill', path: '/skills/beta/SKILL.md', source: 'repo' };
const GAMMA = { name: 'gamma', description: 'Third skill', path: '/skills/gamma/SKILL.md', source: 'claude' };

test('toggleSkill adds a new skill when not present', () => {
  const next = toggleSkill([], ALPHA);
  assert.equal(next.length, 1);
  assert.equal(next[0].path, ALPHA.path);
});

test('toggleSkill removes an existing skill (matched by path)', () => {
  const next = toggleSkill([ALPHA, BETA], { ...ALPHA, source: 'different' });
  assert.equal(next.length, 1);
  assert.equal(next[0].path, BETA.path);
});

test('toggleSkill preserves order when adding', () => {
  const next = toggleSkill([ALPHA, BETA], GAMMA);
  assert.deepEqual(next.map((s) => s.path), [ALPHA.path, BETA.path, GAMMA.path]);
});

test('isSkillSelected matches by path only (case-sensitive)', () => {
  assert.equal(isSkillSelected([ALPHA, BETA], { path: '/skills/alpha/SKILL.md' }), true);
  assert.equal(isSkillSelected([ALPHA, BETA], { path: '/skills/missing/SKILL.md' }), false);
  assert.equal(isSkillSelected([], { path: '/skills/alpha/SKILL.md' }), false);
});

test('selectedSkillsAsBodyEntries produces server-shaped {name, path} list', () => {
  const out = selectedSkillsAsBodyEntries([ALPHA, BETA]);
  assert.deepEqual(out, [
    { name: 'alpha', path: '/skills/alpha/SKILL.md' },
    { name: 'beta', path: '/skills/beta/SKILL.md' }
  ]);
});

test('selectedSkillsAsBodyEntries drops entries without a path', () => {
  const out = selectedSkillsAsBodyEntries([ALPHA, { name: 'broken' }, null]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'alpha');
});

test('filterSkillsByQuery returns full list when query is empty', () => {
  const out = filterSkillsByQuery([ALPHA, BETA, GAMMA], '');
  assert.deepEqual(out.map((s) => s.name), ['alpha', 'beta', 'gamma']);
});

test('filterSkillsByQuery matches name case-insensitively', () => {
  const out = filterSkillsByQuery([ALPHA, BETA, GAMMA], 'AL');
  assert.deepEqual(out.map((s) => s.name), ['alpha']);
});

test('filterSkillsByQuery matches description text too', () => {
  const out = filterSkillsByQuery([ALPHA, BETA, GAMMA], 'Second');
  assert.deepEqual(out.map((s) => s.name), ['beta']);
});

test('filterSkillsByQuery trims whitespace and ignores blanks', () => {
  const out = filterSkillsByQuery([ALPHA, BETA, GAMMA], '   ');
  assert.equal(out.length, 3);
});
