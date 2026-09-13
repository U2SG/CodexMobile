export function normalizeAgentId(value = '') {
  const id = String(value || '').trim().toLowerCase();
  if (id === 'claude' || id === 'claude-code') return 'claude';
  if (id === 'codex' || id === 'openai' || id === 'cliproxyapi') return 'codex';
  return 'unknown';
}

export function normalizeDesktopBridge(bridge = null) {
  return {
    strict: bridge?.strict !== false,
    connected: Boolean(bridge?.connected),
    mode: bridge?.mode || 'unavailable',
    reason: bridge?.reason || null,
    capabilities: bridge?.capabilities && typeof bridge.capabilities === 'object'
      ? bridge.capabilities
      : {}
  };
}

export function desktopBridgeCanCreateThread(bridge = null) {
  const normalized = normalizeDesktopBridge(bridge);
  if (!normalized.connected) {
    return false;
  }
  if (normalized.capabilities.backgroundCodex || normalized.capabilities.createThreadViaBackground) {
    return true;
  }
  if (normalized.capabilities.createThread === false) {
    return false;
  }
  if (normalized.mode === 'desktop-ipc' && normalized.capabilities.createThread !== true) {
    return false;
  }
  return true;
}

export function runtimeCapabilities({
  agentId = '',
  desktopBridge = null,
  sessionId = '',
  selectedSessionId = '',
  sessionIsDraft = false,
  running = false
} = {}) {
  const agent = normalizeAgentId(agentId);
  const bridge = normalizeDesktopBridge(desktopBridge);
  const codexDesktopIpc = agent === 'codex' && bridge.connected && bridge.mode === 'desktop-ipc';
  const codexHeadless = agent === 'codex' && bridge.connected && bridge.mode === 'headless-local';
  const claudeCli = agent === 'claude';
  const effectiveSessionId = sessionId || selectedSessionId;
  const hasRealSession = Boolean(effectiveSessionId && !sessionIsDraft);
  const canCreateThread = agent === 'claude' || desktopBridgeCanCreateThread(bridge);
  const canSteer = Boolean(
    codexDesktopIpc &&
    running &&
    hasRealSession &&
    bridge.capabilities.sendToOpenDesktopThread !== false
  );

  return {
    agent,
    runtime:
      codexDesktopIpc ? 'codex-desktop-ipc' :
        codexHeadless ? 'codex-headless' :
          claudeCli ? 'claude-cli' :
            'unknown',
    canStart: canCreateThread,
    canResume: hasRealSession,
    canQueue: true,
    canInterrupt: Boolean(running),
    canInterruptAndSend: Boolean(running),
    canSteer,
    canPlan: true,
    canImplementPlanBySteer: canSteer,
    canImplementPlanByQueue: true,
    canCompact: claudeCli && hasRealSession,
    canGenerateImage: agent === 'codex',
    canUseDocs: agent === 'codex',
    canUseVoiceHandoff: true,
    canUseGit: true,
    canUseNotifications: true
  };
}

export function canGuideCurrentTask(options = {}) {
  return runtimeCapabilities(options).canSteer;
}
