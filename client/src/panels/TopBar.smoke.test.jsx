import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { TopBar } from './TopBar.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;

function renderTopBar(props = {}) {
  root.render(
    <TopBar
      selectedProject={{ name: 'Mobile Project', path: 'D:/example/mobile-project' }}
      selectedSession={{ title: 'Fix foreground recovery' }}
      connectionState="connected"
      status={{ provider: 'claude' }}
      desktopBridge={{ connected: false, reason: 'Desktop bridge unavailable', mode: 'desktop-ipc' }}
      peers={[]}
      onMenu={() => {}}
      onOpenDocs={() => {}}
      onShowConnectionStatus={() => {}}
      {...props}
    />
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

test('TopBar makes the current session primary and keeps project/path as secondary context', async () => {
  const showStatus = vi.fn();
  await act(async () => renderTopBar({ onShowConnectionStatus: showStatus }));

  expect(container.querySelector('.top-title > strong')?.textContent).toBe('Fix foreground recovery');
  expect(container.querySelector('.top-project-context')?.textContent).toBe('Mobile Project');
  expect(container.textContent).not.toContain('Desktop bridge unavailable');
  expect(container.textContent).not.toContain('桌面');
  expect(container.querySelector('.top-title')?.getAttribute('aria-label')).toContain('D:/example/mobile-project');

  const statusLabel = container.querySelector('.top-meta .connection-status');
  expect(statusLabel?.getAttribute('aria-label')).toContain('Claude Code 已连接');
  expect(container.querySelector('.status-detail-button')).toBeNull();
  expect(showStatus).not.toHaveBeenCalled();
});

test('peer switcher keeps desktop diagnostics behind the secondary connection-detail menu', async () => {
  const showStatus = vi.fn();
  await act(async () => renderTopBar({
    status: { provider: 'codex' },
    desktopBridge: { connected: false, reason: 'IPC unavailable', mode: 'desktop-ipc' },
    peers: [{ label: 'Other agent', url: 'https://agent.example' }],
    onShowConnectionStatus: showStatus
  }));

  expect(container.textContent).not.toContain('IPC unavailable');
  const switcher = container.querySelector('.peer-pill');
  await act(async () => switcher.click());

  expect(container.querySelector('.peer-menu')?.textContent).toContain('连接详情');
  expect(container.querySelector('.peer-menu')?.textContent).toContain('IPC unavailable');
  const detailButton = [...container.querySelectorAll('.peer-menu-item')]
    .find((button) => button.textContent.includes('连接详情'));
  await act(async () => detailButton.click());
  expect(showStatus).toHaveBeenCalledTimes(1);
});
