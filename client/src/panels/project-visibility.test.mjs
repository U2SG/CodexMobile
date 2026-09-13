import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDrawerProjects, projectMatchesQuery } from './project-visibility.js';

const NOW = Date.parse('2026-09-13T06:00:00.000Z');

function project(id, path, {
  name = id,
  sessionCount = 0,
  updatedAt = null
} = {}) {
  return { id, name, path, sessionCount, updatedAt };
}

test('classifyDrawerProjects keeps recent used projects primary and folds old activity', () => {
  const projects = [
    project('recent-1', 'D:/work/recent-1', { sessionCount: 4, updatedAt: '2026-09-13T05:00:00.000Z' }),
    project('recent-2', 'D:/work/recent-2', { sessionCount: 2, updatedAt: '2026-09-11T05:00:00.000Z' }),
    project('old', 'D:/work/old', { sessionCount: 7, updatedAt: '2026-08-20T05:00:00.000Z' })
  ];

  const result = classifyDrawerProjects({ projects, nowMs: NOW });
  assert.deepEqual(result.primaryProjects.map((item) => item.id), ['recent-1', 'recent-2']);
  assert.deepEqual(result.olderProjects.map((item) => item.id), ['old']);
  assert.deepEqual(result.otherProjects, []);
});

test('zero-session, parent-only, and transient paths are folded into other projects', () => {
  const projects = [
    project('parent', 'D:/work', { sessionCount: 0 }),
    project('child-a', 'D:/work/alpha', { sessionCount: 3, updatedAt: '2026-09-13T04:00:00.000Z' }),
    project('child-b', 'D:/work/beta', { sessionCount: 2, updatedAt: '2026-09-12T04:00:00.000Z' }),
    project('empty', 'D:/work/empty', { sessionCount: 0 }),
    project('temp', 'C:/Users/Test/AppData/Local/Temp/codex-run', { sessionCount: 5, updatedAt: '2026-09-13T03:00:00.000Z' }),
    project('stage', 'C:/Users/Test/AppData/Local/codexless-stage-4979b5783b704906bf35885896a196d4', { sessionCount: 1, updatedAt: '2026-09-13T02:00:00.000Z' })
  ];

  const result = classifyDrawerProjects({ projects, nowMs: NOW });
  assert.deepEqual(result.primaryProjects.map((item) => item.id), ['child-a', 'child-b']);
  assert.deepEqual(result.otherProjects.map((item) => item.id), ['temp', 'stage', 'empty', 'parent']);
  assert.equal(result.reasonsById.get('parent'), 'parent');
  assert.equal(result.reasonsById.get('empty'), 'empty');
  assert.equal(result.reasonsById.get('temp'), 'transient');
});

test('selected project is always kept visible even when it would otherwise be folded', () => {
  const projects = [
    project('selected-empty', 'D:/work/empty', { sessionCount: 0 }),
    project('active', 'D:/work/active', { sessionCount: 2, updatedAt: '2026-09-13T05:00:00.000Z' })
  ];

  const result = classifyDrawerProjects({ projects, selectedProjectId: 'selected-empty', nowMs: NOW });
  assert.deepEqual(result.primaryProjects.map((item) => item.id), ['selected-empty', 'active']);
  assert.equal(result.reasonsById.get('selected-empty'), 'selected');
});

test('loaded sessions can rescue a stale zero sessionCount without changing server data', () => {
  const projects = [project('loaded', 'D:/work/loaded', { sessionCount: 0, updatedAt: '2026-09-13T05:00:00.000Z' })];
  const sessionsByProject = { loaded: [{ id: 'session-1' }] };

  const result = classifyDrawerProjects({ projects, sessionsByProject, nowMs: NOW });
  assert.equal(result.primaryProjects[0].id, 'loaded');
  assert.equal(result.primaryProjects[0].sessionCount, 1);
  assert.equal(projects[0].sessionCount, 0);
});

test('projectMatchesQuery matches project names and paths case-insensitively', () => {
  const item = project('startrips', 'D:/StarTrips/loop-workspace', { name: 'Startrips' });
  assert.equal(projectMatchesQuery(item, 'star'), true);
  assert.equal(projectMatchesQuery(item, 'LOOP-WORKSPACE'), true);
  assert.equal(projectMatchesQuery(item, 'semantic'), false);
  assert.equal(projectMatchesQuery(item, ''), false);
});
