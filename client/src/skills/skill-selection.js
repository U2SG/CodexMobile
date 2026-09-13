// Pure helpers for the skill picker. Selection state lives at the App level
// as an array of skill objects ({name, description, path, source}); these
// helpers keep the array operations testable without React.

export function isSkillSelected(selected, skill) {
  if (!skill?.path) return false;
  return Array.isArray(selected) && selected.some((entry) => entry?.path === skill.path);
}

export function toggleSkill(selected, skill) {
  if (!skill?.path) return Array.isArray(selected) ? selected : [];
  const current = Array.isArray(selected) ? selected : [];
  if (isSkillSelected(current, skill)) {
    return current.filter((entry) => entry?.path !== skill.path);
  }
  return [...current, skill];
}

export function selectedSkillsAsBodyEntries(selected) {
  if (!Array.isArray(selected)) return [];
  return selected
    .filter((entry) => entry?.path)
    .map((entry) => ({ name: entry.name || '', path: entry.path }));
}

export function filterSkillsByQuery(skills, query) {
  if (!Array.isArray(skills)) return [];
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return skills;
  return skills.filter((skill) => {
    const haystack = `${skill?.name || ''}\n${skill?.description || ''}`.toLowerCase();
    return haystack.includes(needle);
  });
}
