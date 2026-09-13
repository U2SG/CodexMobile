import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClaudeSkillsAppendix } from './claude-skills.js';

function fakeReader(map) {
  return async (filePath) => {
    if (!Object.prototype.hasOwnProperty.call(map, filePath)) {
      throw new Error(`ENOENT ${filePath}`);
    }
    return map[filePath];
  };
}

test('returns empty string when no skills selected', async () => {
  const out = await buildClaudeSkillsAppendix([], fakeReader({}));
  assert.equal(out, '');
});

test('reads each skill body and joins with delimiters', async () => {
  const skills = [
    { name: 'alpha', path: '/skills/alpha/SKILL.md' },
    { name: 'beta', path: '/skills/beta/SKILL.md' }
  ];
  const reader = fakeReader({
    '/skills/alpha/SKILL.md': '---\nname: alpha\n---\n\nAlpha body.',
    '/skills/beta/SKILL.md': '---\nname: beta\n---\n\nBeta body.'
  });
  const out = await buildClaudeSkillsAppendix(skills, reader);
  assert.match(out, /alpha/);
  assert.match(out, /Alpha body\./);
  assert.match(out, /beta/);
  assert.match(out, /Beta body\./);
});

test('skips skills with unreadable files but keeps the rest', async () => {
  const skills = [
    { name: 'missing', path: '/skills/missing/SKILL.md' },
    { name: 'present', path: '/skills/present/SKILL.md' }
  ];
  const reader = fakeReader({
    '/skills/present/SKILL.md': '---\nname: present\n---\n\nPresent body.'
  });
  const out = await buildClaudeSkillsAppendix(skills, reader);
  assert.doesNotMatch(out, /missing/);
  assert.match(out, /Present body/);
});

test('skips entries without a path', async () => {
  const out = await buildClaudeSkillsAppendix(
    [{ name: 'no-path' }, null, { path: '/skills/x/SKILL.md', name: 'x' }],
    fakeReader({ '/skills/x/SKILL.md': '---\nname: x\n---\n\nX body.' })
  );
  assert.match(out, /X body/);
  assert.doesNotMatch(out, /no-path/);
});

test('includes a header line marking the skill block boundary', async () => {
  const skills = [{ name: 'alpha', path: '/s/a/SKILL.md' }];
  const reader = fakeReader({ '/s/a/SKILL.md': 'Body only.' });
  const out = await buildClaudeSkillsAppendix(skills, reader);
  // Some kind of identifying header so the assistant can tell where a skill
  // section starts; the exact wording is less important than its presence.
  assert.match(out, /alpha/);
  assert.match(out, /Body only\./);
});
