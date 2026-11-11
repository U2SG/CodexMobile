import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { RunsOverviewSheet } from './RunsOverviewSheet.jsx';
import { TopBar } from './TopBar.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const runs = [
  { sessionId: 's2', status: 'approval', title: '重构登录流程', projectName: 'app', worktree: 'login-fix', branch: 'feat/login', approvals: 1, queued: 0 },
  { sessionId: 's1', status: 'running', title: '修复列表排序', projectName: 'app', worktree: null, branch: 'main', startedAt: new Date(Date.now() - 180000).toISOString(), approvals: 0, queued: 0 }
];

test('sheet lists runs with context and opens the tapped one', () => {
  const onSelect = vi.fn();
  act(() => root.render(<RunsOverviewSheet runs={runs} onSelect={onSelect} onClose={() => {}} />));
  const rows = container.querySelectorAll('.runs-sheet__row');
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain('等待审批');
  expect(rows[0].textContent).toContain('app · login-fix · feat/login');
  expect(rows[1].textContent).toContain('运行中 3m');
  act(() => rows[1].click());
  expect(onSelect).toHaveBeenCalledWith(runs[1]);
});

test('top bar shows the pill only while something is in progress', () => {
  const base = {
    selectedProject: { name: 'app', path: '/repo/app' },
    selectedSession: { title: 'x' },
    connectionState: 'connected',
    status: { provider: 'claude' },
    desktopBridge: { connected: false },
    onMenu: () => {}
  };
  act(() => root.render(<TopBar {...base} runs={[]} />));
  expect(container.querySelector('.runs-pill')).toBeNull();
  const onShowRuns = vi.fn();
  act(() => root.render(<TopBar {...base} runs={runs} onShowRuns={onShowRuns} />));
  const pill = container.querySelector('.runs-pill');
  expect(pill.textContent).toContain('2 进行中');
  expect(pill.className).toContain('has-approval');
  act(() => pill.click());
  expect(onShowRuns).toHaveBeenCalled();
});
