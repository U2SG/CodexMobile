export const AGENT_MODE = String(process.env.CODEXMOBILE_AGENT || process.env.CODEXMOBILE_BACKEND || 'codex')
  .trim()
  .toLowerCase();

export function isClaudeMode() {
  return AGENT_MODE === 'claude' || AGENT_MODE === 'claude-code';
}

export function agentLabel() {
  return isClaudeMode() ? 'Claude Code' : 'Codex';
}

export function defaultProvider() {
  return isClaudeMode() ? 'claude' : 'codex';
}

export function defaultModel() {
  // Bare alias, not a pinned `claude-sonnet-5`: this value round-trips through
  // the client back into resolveClaudeModel, so an alias keeps following the
  // latest of the family instead of freezing on one release.
  return isClaudeMode() ? 'sonnet' : 'gpt-5.5';
}

export function defaultModelShort() {
  return isClaudeMode() ? 'Sonnet 5' : '5.5 中';
}
