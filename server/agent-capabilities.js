import { defaultProvider } from './agent-mode.js';

export function normalizeAgentProvider(value = '') {
  const provider = String(value || '').trim().toLowerCase();
  if (provider === 'claude' || provider === 'claude-code') return 'claude';
  if (provider === 'codex' || provider === 'openai' || provider === 'cliproxyapi') return 'codex';
  return 'unknown';
}

export function isClaudeProvider(value = '') {
  return normalizeAgentProvider(value) === 'claude';
}

export function isCodexProvider(value = '') {
  return normalizeAgentProvider(value) === 'codex';
}

export function sessionAgentId(session = null) {
  if (!session) {
    return 'unknown';
  }
  const source = String(session.source || '').trim().toLowerCase();
  if (source === 'claude-code' || source === 'claude-code-mobile') {
    return 'claude';
  }
  if (source === 'codex-app') {
    return 'codex';
  }
  // 'codexmobile' deliberately falls through: both server instances write
  // mobile registrations with that source, so it says "registered from the
  // PWA", not which agent owns it — the provider field decides.
  return normalizeAgentProvider(session.provider);
}

export function currentAgentMatchesSession(session = null, provider = defaultProvider()) {
  const sessionAgent = sessionAgentId(session);
  if (sessionAgent === 'unknown') {
    return true;
  }
  return sessionAgent === normalizeAgentProvider(provider);
}

export function agentCapabilities(provider = defaultProvider()) {
  const agent = normalizeAgentProvider(provider);
  const claude = agent === 'claude';
  const codex = agent === 'codex';
  return {
    agent,
    canStart: agent !== 'unknown',
    canResume: agent !== 'unknown',
    canQueue: agent !== 'unknown',
    canInterrupt: agent !== 'unknown',
    canInterruptAndSend: agent !== 'unknown',
    canSteer: false,
    canPlan: agent !== 'unknown',
    canImplementPlanBySteer: false,
    canImplementPlanByQueue: agent !== 'unknown',
    canCompact: claude,
    canGenerateImage: codex,
    canUseDocs: codex,
    canUseVoiceHandoff: agent !== 'unknown',
    canUseGit: agent !== 'unknown',
    canUseNotifications: agent !== 'unknown',
    runtimeFamily: claude ? 'claude-cli' : codex ? 'codex' : 'unknown'
  };
}
