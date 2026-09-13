import assert from 'node:assert/strict';
import test from 'node:test';
import { canGuideCurrentTask, composerSendState } from './send-state.js';

test('composerSendState blocks sending when bridge is unavailable AND agent is unknown', () => {
  // Without agentId hint, the helper preserves the conservative
  // "no bridge → no send" upstream contract — caller hasn't told us
  // which backend would handle the fallback.
  const state = composerSendState({
    hasInput: true,
    desktopBridge: { connected: false, mode: 'unavailable' }
  });

  assert.equal(state.disabled, true);
  assert.equal(state.mode, 'unavailable');
  assert.equal(state.label, '桌面端 Codex 未连接');
});

test('composerSendState allows codex sends when the desktop bridge is down (server falls back)', () => {
  const state = composerSendState({
    agentId: 'codex',
    hasInput: true,
    desktopBridge: { connected: false, mode: 'unavailable' }
  });

  assert.equal(state.disabled, false);
  assert.equal(state.mode, 'start');
});

test('composerSendState allows claude sends regardless of bridge state', () => {
  const state = composerSendState({
    agentId: 'claude',
    hasInput: true,
    desktopBridge: null
  });

  assert.equal(state.disabled, false);
  assert.equal(state.mode, 'start');
});

test('composerSendState starts a desktop turn when idle', () => {
  const state = composerSendState({
    hasInput: true,
    desktopBridge: { connected: true, mode: 'desktop-proxy', capabilities: { createThread: true } },
    sessionIsDraft: true
  });

  assert.equal(state.disabled, false);
  assert.equal(state.mode, 'start');
  assert.equal(state.showMenu, false);
});

test('composerSendState defaults running input to steer when possible', () => {
  const state = composerSendState({
    running: true,
    hasInput: true,
    steerable: true,
    desktopBridge: { connected: true, mode: 'desktop-proxy' }
  });

  assert.equal(state.mode, 'steer');
  assert.equal(state.showMenu, true);
  assert.equal(state.canSteer, true);
});

test('composerSendState preserves queue and interrupt when active turn cannot steer', () => {
  const state = composerSendState({
    running: true,
    hasInput: true,
    steerable: false,
    desktopBridge: { connected: true, mode: 'desktop-proxy' }
  });

  assert.equal(state.mode, 'queue');
  assert.equal(state.canSteer, false);
  assert.equal(state.canQueue, true);
  assert.equal(state.canInterrupt, true);
});

test('composerSendState blocks codex draft sends when desktop direct creation is unavailable', () => {
  const state = composerSendState({
    agentId: 'codex',
    hasInput: true,
    sessionIsDraft: true,
    desktopBridge: {
      connected: true,
      mode: 'desktop-ipc',
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }
  });

  assert.equal(state.disabled, true);
  assert.equal(state.mode, 'create-unavailable');
  assert.equal(state.label, '只能继续桌面端已有对话');
});

test('composerSendState allows claude draft sends even if desktop direct creation is unavailable', () => {
  const state = composerSendState({
    agentId: 'claude',
    hasInput: true,
    sessionIsDraft: true,
    desktopBridge: {
      connected: true,
      mode: 'desktop-ipc',
      capabilities: { createThread: false }
    }
  });

  assert.equal(state.disabled, false);
  assert.equal(state.mode, 'start');
});

test('composerSendState still allows existing desktop threads when createThread is unavailable', () => {
  const state = composerSendState({
    hasInput: true,
    sessionIsDraft: false,
    desktopBridge: {
      connected: true,
      mode: 'desktop-ipc',
      capabilities: { sendToOpenDesktopThread: true, createThread: false }
    }
  });

  assert.equal(state.disabled, false);
  assert.equal(state.mode, 'start');
});

test('composerSendState allows draft sends in headless local mode', () => {
  const state = composerSendState({
    hasInput: true,
    sessionIsDraft: true,
    desktopBridge: {
      connected: true,
      mode: 'headless-local',
      capabilities: { createThread: true }
    }
  });

  assert.equal(state.disabled, false);
  assert.equal(state.mode, 'start');
});

test('composerSendState allows draft sends through desktop background fallback', () => {
  const state = composerSendState({
    hasInput: true,
    sessionIsDraft: true,
    desktopBridge: {
      connected: true,
      mode: 'desktop-ipc',
      capabilities: {
        createThread: false,
        backgroundCodex: true,
        createThreadViaBackground: true
      }
    }
  });

  assert.equal(state.disabled, false);
  assert.equal(state.mode, 'start');
});

test('canGuideCurrentTask is limited to Codex desktop IPC real sessions', () => {
  const desktopBridge = {
    connected: true,
    mode: 'desktop-ipc',
    capabilities: { sendToOpenDesktopThread: true }
  };

  assert.equal(canGuideCurrentTask({
    agentId: 'codex',
    running: true,
    selectedSessionId: 'thread-1',
    sessionIsDraft: false,
    desktopBridge
  }), true);
  assert.equal(canGuideCurrentTask({
    agentId: 'claude',
    running: true,
    selectedSessionId: 'thread-1',
    sessionIsDraft: false,
    desktopBridge
  }), false);
  assert.equal(canGuideCurrentTask({
    agentId: 'codex',
    running: true,
    selectedSessionId: 'draft-project-1',
    sessionIsDraft: true,
    desktopBridge
  }), false);
  assert.equal(canGuideCurrentTask({
    agentId: 'codex',
    running: true,
    selectedSessionId: 'thread-1',
    sessionIsDraft: false,
    desktopBridge: { connected: true, mode: 'headless-local' }
  }), false);
});
