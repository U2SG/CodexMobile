export const AGENT_MODE = String(process.env.CODEXMOBILE_AGENT || process.env.CODEXMOBILE_BACKEND || 'codex')
  .trim()
  .toLowerCase();

export function isClaudeMode() {
  return AGENT_MODE === 'claude' || AGENT_MODE === 'claude-code';
}

export function isAgyMode() {
  return AGENT_MODE === 'agy' || AGENT_MODE === 'antigravity';
}

export function agentLabel() {
  if (isClaudeMode()) return 'Claude Code';
  if (isAgyMode()) return 'AGY';
  return 'Codex';
}

export function defaultProvider() {
  if (isClaudeMode()) return 'claude';
  if (isAgyMode()) return 'agy';
  return 'codex';
}

export function defaultModel() {
  // Bare alias, not a pinned `claude-sonnet-*` id: this value round-trips
  // through the client back into resolveClaudeModel, so the CLI keeps following
  // the latest release in that family.
  if (isClaudeMode()) return 'sonnet';
  if (isAgyMode()) return 'gemini-4-neon-high';
  return 'gpt-5.5';
}

export function defaultModelShort() {
  if (isClaudeMode()) return 'Sonnet';
  if (isAgyMode()) return 'G4 Neon';
  return '5.5 中';
}
