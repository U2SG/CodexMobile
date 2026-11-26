import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentMeta,
  isAgyProvider,
  isClaudeProvider,
  isCodexProvider,
  providerFromStatus,
  sessionSourceBadge
} from './agent-meta.js';

test('provider helpers normalize Codex, Claude, and AGY route identities', () => {
  assert.equal(providerFromStatus({ provider: 'cliproxyapi' }), 'cliproxyapi');
  assert.equal(isCodexProvider('openai'), true);
  assert.equal(isCodexProvider({ provider: 'codex' }), true);
  assert.equal(isClaudeProvider({ provider: 'claude' }), true);
  assert.equal(isClaudeProvider({ provider: 'codex' }), false);
  assert.equal(isAgyProvider({ provider: 'agy' }), true);
  assert.equal(isAgyProvider('antigravity'), true);
  assert.equal(isAgyProvider('codex'), false);
  assert.deepEqual(sessionSourceBadge('agy'), { className: 'is-agy', label: 'AGY' });
});

test('agentMeta preserves unknown as a route state', () => {
  const agent = agentMeta({ provider: null });
  assert.equal(agent.id, 'unknown');
  assert.equal(agent.shortLabel, 'CodexMobile');
  assert.equal(agent.accentClass, '');
});

test('agentMeta returns route-specific display metadata', () => {
  assert.equal(agentMeta('claude').id, 'claude');
  assert.equal(agentMeta('claude').providerLabel, 'Claude CLI');
  assert.equal(agentMeta('agy').id, 'agy');
  assert.equal(agentMeta('agy').providerLabel, 'AGY CLI');
  assert.equal(agentMeta('agy').accentClass, 'is-agy');
  assert.equal(agentMeta('cliproxyapi').id, 'codex');
  assert.equal(agentMeta('cliproxyapi').providerLabel, 'Codex SDK');
});
