import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canGuideCurrentTask,
  desktopBridgeCanCreateThread,
  runtimeCapabilities
} from './runtime-capabilities.js';

const desktopIpcBridge = {
  connected: true,
  mode: 'desktop-ipc',
  capabilities: { sendToOpenDesktopThread: true, createThread: false }
};

test('runtimeCapabilities exposes Codex desktop IPC steer as a narrow capability', () => {
  const capabilities = runtimeCapabilities({
    agentId: 'codex',
    desktopBridge: desktopIpcBridge,
    sessionId: 'thread-1',
    sessionIsDraft: false,
    running: true
  });

  assert.equal(capabilities.runtime, 'codex-desktop-ipc');
  assert.equal(capabilities.canSteer, true);
  assert.equal(capabilities.canImplementPlanBySteer, true);
  assert.equal(capabilities.canQueue, true);
  assert.equal(capabilities.canCompact, false);
  assert.equal(capabilities.canGenerateImage, true);
});

test('runtimeCapabilities treats Codex headless as queue/interrupt but not steer', () => {
  const capabilities = runtimeCapabilities({
    agentId: 'codex',
    desktopBridge: { connected: true, mode: 'headless-local', capabilities: { createThread: true } },
    sessionId: 'thread-1',
    running: true
  });

  assert.equal(capabilities.runtime, 'codex-headless');
  assert.equal(capabilities.canSteer, false);
  assert.equal(capabilities.canQueue, true);
  assert.equal(capabilities.canInterruptAndSend, true);
  assert.equal(capabilities.canGenerateImage, true);
});

test('runtimeCapabilities keeps Claude CLI separate from Codex-only features', () => {
  const capabilities = runtimeCapabilities({
    agentId: 'claude',
    desktopBridge: null,
    sessionId: 'claude-session-1',
    running: true
  });

  assert.equal(capabilities.runtime, 'claude-cli');
  assert.equal(capabilities.canSteer, false);
  assert.equal(capabilities.canCompact, true);
  assert.equal(capabilities.canGenerateImage, false);
  assert.equal(capabilities.canUseDocs, false);
});

test('canGuideCurrentTask and desktopBridgeCanCreateThread preserve send-state behavior', () => {
  assert.equal(canGuideCurrentTask({
    agentId: 'codex',
    desktopBridge: desktopIpcBridge,
    sessionId: 'thread-1',
    running: true
  }), true);
  assert.equal(canGuideCurrentTask({
    agentId: 'claude',
    desktopBridge: desktopIpcBridge,
    sessionId: 'thread-1',
    running: true
  }), false);
  assert.equal(desktopBridgeCanCreateThread(desktopIpcBridge), false);
  assert.equal(desktopBridgeCanCreateThread({
    connected: true,
    mode: 'desktop-ipc',
    capabilities: { createThread: false, backgroundCodex: true }
  }), true);
});
