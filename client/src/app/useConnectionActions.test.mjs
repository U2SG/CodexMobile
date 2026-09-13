import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONNECTION_STATUS,
  formatConnectionStatusMessage
} from './useConnectionActions.js';

test('formatConnectionStatusMessage uses the label dict and desktop reason when both are known', () => {
  const message = formatConnectionStatusMessage({
    connectionState: 'connected',
    desktopBridge: { reason: '已连接到 IPC', mode: 'desktop-ipc' }
  });
  assert.equal(message, `连接：${CONNECTION_STATUS.connected.label}\n桌面：已连接到 IPC`);
});

test('formatConnectionStatusMessage falls back to bridge.mode when reason is missing', () => {
  const message = formatConnectionStatusMessage({
    connectionState: 'connecting',
    desktopBridge: { mode: 'background' }
  });
  assert.equal(message, `连接：${CONNECTION_STATUS.connecting.label}\n桌面：background`);
});

test('formatConnectionStatusMessage falls back to default detail when bridge is empty', () => {
  const message = formatConnectionStatusMessage({
    connectionState: 'disconnected',
    desktopBridge: null
  });
  assert.equal(
    message,
    `连接：${CONNECTION_STATUS.disconnected.label}\n桌面：桌面桥接状态未返回详情。`
  );
});

test('formatConnectionStatusMessage uses the raw state when not in CONNECTION_STATUS', () => {
  const message = formatConnectionStatusMessage({
    connectionState: 'mystery',
    desktopBridge: { reason: 'ok' }
  });
  assert.equal(message, '连接：mystery\n桌面：ok');
});

test('formatConnectionStatusMessage hides Codex desktop diagnostics in Claude mode', () => {
  const message = formatConnectionStatusMessage({
    connectionState: 'connected',
    provider: 'claude',
    desktopBridge: { reason: 'Codex IPC pipe missing', mode: 'desktop-ipc' }
  });
  assert.equal(message, `连接：${CONNECTION_STATUS.connected.label}`);
});
