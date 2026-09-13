import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentMeta,
  isClaudeProvider,
  isCodexProvider,
  providerFromStatus
} from './agent-meta.js';

test('provider helpers normalize Codex and Claude route identities', () => {
  assert.equal(providerFromStatus({ provider: 'cliproxyapi' }), 'cliproxyapi');
  assert.equal(isCodexProvider('openai'), true);
  assert.equal(isCodexProvider({ provider: 'codex' }), true);
  assert.equal(isClaudeProvider({ provider: 'claude' }), true);
  assert.equal(isClaudeProvider({ provider: 'codex' }), false);
});

test('agentMeta preserves unknown as a third route state', () => {
  const agent = agentMeta({ provider: null });
  assert.equal(agent.id, 'unknown');
  assert.equal(agent.shortLabel, 'CodexMobile');
  assert.equal(agent.accentClass, '');
});

test('agentMeta returns route-specific display metadata', () => {
  assert.equal(agentMeta('claude').id, 'claude');
  assert.equal(agentMeta('claude').providerLabel, 'Claude CLI');
  assert.equal(agentMeta('cliproxyapi').id, 'codex');
  assert.equal(agentMeta('cliproxyapi').providerLabel, 'Codex SDK');
}
);
