export {
  canGuideCurrentTask,
  desktopBridgeCanCreateThread,
  normalizeDesktopBridge
} from './runtime-capabilities.js';

import {
  desktopBridgeCanCreateThread,
  normalizeAgentId,
  normalizeDesktopBridge
} from './runtime-capabilities.js';

export function composerSendState({
  agentId = '',
  running = false,
  hasInput = false,
  uploading = false,
  desktopBridge = null,
  steerable = true,
  sessionIsDraft = false
} = {}) {
  const bridge = normalizeDesktopBridge(desktopBridge);
  const agent = normalizeAgentId(agentId);

  // Headless path: server spawns the codex/claude CLI directly when the
  // desktop bridge is down, so the composer must NOT block on
  // bridge.connected. Only the codex-desktop-IPC-specific features
  // (steer-on-running-task) gate on the bridge below.
  //   - claude  → never depends on the bridge at all.
  //   - codex   → bridge presence affects steer + create-via-desktop
  //               affordances, but a fresh send still works via the
  //               server's fallback path.
  //   - unknown → preserve the old "block on disconnect" contract so
  //               callers that haven't been agent-updated don't
  //               accidentally enable an undefined backend.
  if (!bridge.connected && agent === 'unknown') {
    return {
      disabled: true,
      label: '桌面端 Codex 未连接',
      mode: 'unavailable',
      showMenu: false,
      canSteer: false,
      canQueue: false,
      canInterrupt: false
    };
  }

  // The "create-thread via desktop only" gate applies only when we're
  // running a codex draft AND the server can't fall back. Claude has its
  // own thread-creation path that doesn't go through the desktop bridge.
  if (agent === 'codex' && sessionIsDraft && bridge.connected && !desktopBridgeCanCreateThread(bridge)) {
    return {
      disabled: true,
      label: '只能继续桌面端已有对话',
      mode: 'create-unavailable',
      showMenu: false,
      canSteer: false,
      canQueue: false,
      canInterrupt: false
    };
  }
  if (uploading) {
    return {
      disabled: true,
      label: '正在上传',
      mode: 'uploading',
      showMenu: false,
      canSteer: false,
      canQueue: false,
      canInterrupt: false
    };
  }
  if (running && !hasInput) {
    return {
      disabled: false,
      label: '中止当前任务',
      mode: 'abort',
      showMenu: false,
      canSteer: false,
      canQueue: false,
      canInterrupt: true
    };
  }
  if (running && hasInput) {
    return {
      disabled: false,
      label: steerable ? '发送到当前任务' : '选择发送方式',
      mode: steerable ? 'steer' : 'queue',
      showMenu: true,
      canSteer: Boolean(steerable),
      canQueue: true,
      canInterrupt: true
    };
  }
  return {
    disabled: !hasInput,
    label: '发送消息',
    mode: 'start',
    showMenu: false,
    canSteer: false,
    canQueue: false,
    canInterrupt: false
  };
}
