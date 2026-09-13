// Build a system-prompt appendix from selected skill SKILL.md files for the
// Claude CLI path. Codex SDK accepts {type:'skill', path} structured items
// natively; the Claude CLI has no such concept, so we read the file bodies
// and concatenate them into a delimited block that we feed via
// --append-system-prompt.

import fs from 'node:fs/promises';

function skillHeader(name) {
  const label = String(name || '').trim() || 'skill';
  return `### Skill: ${label}`;
}

export async function buildClaudeSkillsAppendix(selectedSkills, readFile = fs.readFile.bind(fs)) {
  const skills = Array.isArray(selectedSkills) ? selectedSkills : [];
  if (!skills.length) return '';
  const sections = [];
  for (const skill of skills) {
    if (!skill?.path) continue;
    let body;
    try {
      body = await readFile(skill.path, 'utf8');
    } catch (error) {
      console.warn(`[claude-skills] skipping ${skill.name || skill.path}: ${error.message}`);
      continue;
    }
    const trimmed = String(body || '').trim();
    if (!trimmed) continue;
    sections.push(`${skillHeader(skill.name)}\n\n${trimmed}`);
  }
  if (!sections.length) return '';
  return ['## Skills available for this turn', ...sections].join('\n\n');
}
