const DEFAULT_RECENT_DAYS = 7;

function normalizedProjectPath(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function projectActivityMs(project) {
  const timestamp = project?.updatedAt ? new Date(project.updatedAt).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function projectSessionCount(project, sessionsByProject = {}) {
  const explicit = Number(project?.sessionCount);
  const loaded = Array.isArray(sessionsByProject?.[project?.id])
    ? sessionsByProject[project.id].length
    : 0;
  return Math.max(Number.isFinite(explicit) && explicit > 0 ? explicit : 0, loaded);
}

function isStrictAncestorPath(parentPath, childPath) {
  const parent = normalizedProjectPath(parentPath);
  const child = normalizedProjectPath(childPath);
  if (!parent || !child || parent === child) return false;
  return child.startsWith(`${parent}/`);
}

function isTransientProjectPath(value) {
  const normalized = normalizedProjectPath(value);
  if (!normalized) return false;
  const segments = normalized.split('/').filter(Boolean);
  const base = segments.at(-1) || '';
  if (normalized.includes('/appdata/local/temp/')) return true;
  if (base === 'temp' || base === 'tmp') return true;
  return /^codexless-stage-[a-f0-9-]{8,}$/i.test(base);
}

function compareByActivity(a, b) {
  const activityDelta = projectActivityMs(b) - projectActivityMs(a);
  if (activityDelta) return activityDelta;
  const sessionDelta = Number(b.sessionCount || 0) - Number(a.sessionCount || 0);
  if (sessionDelta) return sessionDelta;
  return String(a.name || a.path || '').localeCompare(String(b.name || b.path || ''), 'zh-Hans-CN');
}

export function projectMatchesQuery(project, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return false;
  return [project?.name, project?.path]
    .some((value) => String(value || '').toLowerCase().includes(needle));
}

export function classifyDrawerProjects({
  projects = [],
  sessionsByProject = {},
  selectedProjectId = '',
  nowMs = Date.now(),
  recentDays = DEFAULT_RECENT_DAYS
} = {}) {
  const list = Array.isArray(projects) ? projects.filter(Boolean) : [];
  const cutoff = Number(nowMs) - Number(recentDays || DEFAULT_RECENT_DAYS) * 24 * 60 * 60 * 1000;
  const pathById = new Map(list.map((project) => [project.id, normalizedProjectPath(project.path)]));
  const descendantCount = new Map();

  for (const project of list) {
    const parentPath = pathById.get(project.id);
    if (!parentPath) continue;
    let count = 0;
    for (const candidate of list) {
      if (candidate.id === project.id) continue;
      if (isStrictAncestorPath(parentPath, pathById.get(candidate.id))) count += 1;
    }
    descendantCount.set(project.id, count);
  }

  const primaryProjects = [];
  const olderProjects = [];
  const otherProjects = [];
  const reasonsById = new Map();

  for (const project of list) {
    const sessionCount = projectSessionCount(project, sessionsByProject);
    const activityMs = projectActivityMs(project);
    const selected = project.id === selectedProjectId;
    const transient = isTransientProjectPath(project.path);
    const structuralParent = (descendantCount.get(project.id) || 0) >= 2;
    const decorated = { ...project, sessionCount };

    if (selected) {
      primaryProjects.push(decorated);
      reasonsById.set(project.id, 'selected');
      continue;
    }

    if (transient) {
      otherProjects.push(decorated);
      reasonsById.set(project.id, 'transient');
      continue;
    }

    if (sessionCount === 0) {
      otherProjects.push(decorated);
      reasonsById.set(project.id, structuralParent ? 'parent' : 'empty');
      continue;
    }

    if (activityMs && activityMs < cutoff) {
      olderProjects.push(decorated);
      reasonsById.set(project.id, 'older');
      continue;
    }

    primaryProjects.push(decorated);
    reasonsById.set(project.id, 'active');
  }

  primaryProjects.sort((a, b) => {
    if (a.id === selectedProjectId && b.id !== selectedProjectId) return -1;
    if (b.id === selectedProjectId && a.id !== selectedProjectId) return 1;
    return compareByActivity(a, b);
  });
  olderProjects.sort(compareByActivity);
  otherProjects.sort(compareByActivity);

  return {
    primaryProjects,
    olderProjects,
    otherProjects,
    reasonsById
  };
}
