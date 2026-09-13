import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentCapabilities,
  currentAgentMatchesSession,
  isClaudeProvider,
  isCodexProvider,
  normalizeAgentProvider,
  sessionAgentId
} from './agent-capabilities.js';

test('normalizes provider names into route identities', () => {
  assert.equal(normalizeAgentProvider('claude-code'), 'claude');
  assert.equal(normalizeAgentProvider('cliproxyapi'), 'codex');
  assert.equal(isClaudeProvider('claude'), true);
  assert.equal(isCodexProvider('openai'), true);
});

test('sessionAgentId prefers source markers over provider fallback', () => {
  assert.equal(sessionAgentId({ source: 'claude-code-mobile', provider: 'codex' }), 'claude');
  assert.equal(sessionAgentId({ source: 'codex-app', provider: 'claude' }), 'codex');
  assert.equal(sessionAgentId({ provider: 'claude' }), 'claude');
  assert.equal(sessionAgentId({}), 'unknown');
});

test('currentAgentMatchesSession keeps unknown sessions visible', () => {
  assert.equal(currentAgentMatchesSession({ provider: 'claude' }, 'codex'), false);
  // 'codexmobile' is written by BOTH server instances — it must not force the
  // codex identity; the provider stamp decides, absent one the session stays
  // visible everywhere.
  assert.equal(currentAgentMatchesSession({ source: 'codexmobile' }, 'codex'), true);
  assert.equal(currentAgentMatchesSession({ source: 'codexmobile', provider: 'claude' }, 'codex'), false);
  assert.equal(currentAgentMatchesSession({ source: 'codexmobile', provider: 'claude' }, 'claude'), true);
  assert.equal(currentAgentMatchesSession({}, 'claude'), true);
});

test('agentCapabilities separates common, Codex-only, and Claude-only abilities', () => {
  const codex = agentCapabilities('codex');
  assert.equal(codex.canGenerateImage, true);
  assert.equal(codex.canCompact, false);
  assert.equal(codex.canSteer, false);

  const claude = agentCapabilities('claude');
  assert.equal(claude.canGenerateImage, false);
  assert.equal(claude.canCompact, true);
  assert.equal(claude.canUseDocs, false);
}
);
