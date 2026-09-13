import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSessionLocalState, filterDeletedMessages } from './session-local-state.js';

async function withTempState(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-session-state-'));
  try {
    await fn(createSessionLocalState({
      deletedMessagesPath: path.join(dir, 'deleted-messages.json'),
      hiddenSessionsPath: path.join(dir, 'hidden-sessions.json'),
      hiddenProjectsPath: path.join(dir, 'hidden-projects.json')
    }));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('session local state hides sessions and preserves the first hiddenAt timestamp', async () => {
  await withTempState(async (state) => {
    const first = await state.hideSessionInMobile({
      id: 'session-1',
      projectId: 'project-1',
      cwd: '/tmp/project',
      title: 'First title'
    });
    const second = await state.hideSessionInMobile({
      id: 'session-1',
      projectId: 'project-2',
      cwd: '/tmp/project-2',
      title: 'Second title'
    });

    assert.equal(second.hiddenAt, first.hiddenAt);
    assert.deepEqual(await state.readHiddenSessionIds(), new Set(['session-1']));
  });
});

test('session local state archives and restores projects', async () => {
  await withTempState(async (state) => {
    const first = await state.hideProjectInMobile({
      id: 'project-1',
      name: 'Project One',
      path: '/tmp/project',
      sessionCount: 3
    });
    const second = await state.hideProjectInMobile({
      id: 'project-1',
      name: 'Renamed',
      path: '/tmp/project',
      sessionCount: 4
    });

    assert.equal(second.hiddenAt, first.hiddenAt);
    assert.deepEqual(await state.readHiddenProjectIds(), new Set(['project-1']));
    assert.deepEqual(await state.readHiddenProjects(), [{
      id: 'project-1',
      hiddenAt: first.hiddenAt,
      name: 'Renamed',
      path: '/tmp/project',
      sessionCount: 4
    }]);

    assert.deepEqual(await state.restoreProjectInMobile('project-1'), {
      projectId: 'project-1',
      restored: true,
      project: {
        id: 'project-1',
        hiddenAt: first.hiddenAt,
        name: 'Renamed',
        path: '/tmp/project',
        sessionCount: 4
      }
    });
    assert.deepEqual(await state.readHiddenProjectIds(), new Set());
  });
});

test('session local state records hidden message ids and filters them from message lists', async () => {
  await withTempState(async (state) => {
    await state.hideSessionMessage('session-1', 'message-2');
    const deletedIds = await state.readDeletedMessageIds('session-1');

    assert.deepEqual(deletedIds, new Set(['message-2']));
    assert.deepEqual(filterDeletedMessages([
      { id: 'message-1', content: 'keep' },
      { id: 'message-2', content: 'hide' },
      { id: 'message-3', content: 'keep too' }
    ], deletedIds), [
      { id: 'message-1', content: 'keep' },
      { id: 'message-3', content: 'keep too' }
    ]);
  });
});

test('session local state keeps existing validation and default empty reads', async () => {
  await withTempState(async (state) => {
    assert.deepEqual(await state.readDeletedMessageIds('missing-session'), new Set());
    await assert.rejects(
      () => state.hideSessionMessage('', 'message-1'),
      /sessionId and messageId are required/
    );
    await assert.rejects(
      () => state.hideSessionInMobile({ id: '' }),
      /Session id is required/
    );
    await assert.rejects(
      () => state.hideProjectInMobile({ id: '' }),
      /Project id is required/
    );
    await assert.rejects(
      () => state.restoreProjectInMobile(''),
      /Project id is required/
    );
  });
});
