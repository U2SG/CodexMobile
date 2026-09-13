import test from 'node:test';
import assert from 'node:assert/strict';

import { readClaudeConfig } from './claude-config.js';

function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (had) {
        process.env[key] = prev;
      } else {
        delete process.env[key];
      }
    });
}

test('default model list ships the Claude 5 families as bare CLI aliases', async () => {
  await withEnv('CODEXMOBILE_CLAUDE_MODELS', undefined, async () => {
    const config = await readClaudeConfig();
    const byValue = new Map(config.models.map((m) => [m.value, m]));

    assert.deepEqual(byValue.get('opus'), {
      value: 'opus',
      label: 'Claude Opus 5',
      resolvedModel: 'claude-opus-5'
    });
    // Fable is a native CLI alias too, so it floats with the family like the
    // others instead of pinning a full `claude-fable-5` id.
    assert.deepEqual(byValue.get('fable'), {
      value: 'fable',
      label: 'Claude Fable 5',
      resolvedModel: 'claude-fable-5'
    });
    assert.equal(byValue.get('sonnet').label, 'Claude Sonnet 5');
    assert.equal(byValue.get('haiku').label, 'Claude Haiku 4.5');
  });
});

test('CODEXMOBILE_CLAUDE_MODELS overrides the picker and auto-labels full ids', async () => {
  await withEnv('CODEXMOBILE_CLAUDE_MODELS', 'opus, claude-sonnet-6-1 , sonnet', async () => {
    const config = await readClaudeConfig();
    assert.deepEqual(
      config.models.map((m) => m.value),
      ['opus', 'claude-sonnet-6-1', 'sonnet']
    );
    // A future model needs no code change — the family/version regex labels it.
    const future = config.models.find((m) => m.value === 'claude-sonnet-6-1');
    assert.equal(future.label, 'Claude Sonnet 6.1');
    assert.equal(future.resolvedModel, 'claude-sonnet-6-1');
  });
});
