import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { Drawer } from './Drawer.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;

function renderDrawer(overrides = {}) {
  const onNewConversation = vi.fn();
  const props = {
    open: true,
    onClose: vi.fn(),
    projects: [],
    pinFolders: [],
    pinnedSessions: [],
    selectedProject: null,
    selectedSession: null,
    expandedProjectIds: {},
    sessionsByProject: {},
    loadingProjectId: '',
    onToggleProject: vi.fn(),
    onSelectProject: vi.fn(),
    onSelectSession: vi.fn(),
    onRenameSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onArchiveProject: vi.fn(),
    onRestoreProject: vi.fn(),
    onTogglePin: vi.fn(),
    onMoveSessionToFolder: vi.fn(),
    onCreatePinFolder: vi.fn(),
    onRenamePinFolder: vi.fn(),
    onDeletePinFolder: vi.fn(),
    onToggleFolderCollapsed: vi.fn(),
    onNewConversation,
    onSync: vi.fn(),
    onOpenGit: vi.fn(),
    onOpenNotifications: vi.fn(),
    onOpenActivity: vi.fn(),
    onShowConnectionStatus: vi.fn(),
    peers: [],
    syncing: false,
    theme: 'light',
    setTheme: vi.fn(),
    status: { provider: 'codex' },
    desktopBridge: { connected: true, openThreadIds: [] },
    runtimePrefs: { ipcTurnsEnabled: false },
    onSetRuntimePref: vi.fn(),
    ...overrides
  };
  root.render(<Drawer {...props} />);
  return { props, onNewConversation };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

test('drawer places search and compact new-conversation action on one toolbar row', async () => {
  let rendered;
  await act(async () => {
    rendered = renderDrawer();
  });

  const bar = container.querySelector('.drawer-search-bar');
  const closeButton = container.querySelector('[aria-label="关闭菜单"]');
  const search = container.querySelector('[aria-label="搜索项目或对话"]');
  const newButton = container.querySelector('.drawer-new-compact');

  expect(bar).not.toBeNull();
  expect(search).not.toBeNull();
  expect(newButton?.textContent).toContain('新建');
  expect(bar.contains(closeButton)).toBe(true);
  expect(bar.contains(search)).toBe(true);
  expect(bar.contains(newButton)).toBe(true);
  expect(container.querySelector('.drawer-grip')).toBeNull();
  expect(container.querySelector('.drawer-new-icon')).toBeNull();

  await act(async () => newButton.click());
  expect(rendered.onNewConversation).toHaveBeenCalledTimes(1);
});
