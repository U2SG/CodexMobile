import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readClaudeConfig, recordClaudeResolvedModel } from './claude-config.js';

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

async function withModelCache(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-claude-models-'));
  const cachePath = path.join(dir, 'aliases.json');
  try {
    await withEnv('CODEXMOBILE_CLAUDE_MODEL_CACHE', cachePath, fn);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('default model list uses bare aliases without inventing a version', async () => {
  await withModelCache(async () => {
    await withEnv('CODEXMOBILE_CLAUDE_MODELS', undefined, async () => {
      const config = await readClaudeConfig();
      const byValue = new Map(config.models.map((m) => [m.value, m]));

      assert.deepEqual(byValue.get('opus'), {
        value: 'opus',
        label: 'Claude Opus',
        resolvedModel: null
      });
      assert.deepEqual(byValue.get('fable'), {
        value: 'fable',
        label: 'Claude Fable',
        resolvedModel: null
      });
      assert.equal(byValue.get('sonnet').label, 'Claude Sonnet');
      assert.equal(byValue.get('haiku').label, 'Claude Haiku');
      assert.equal(config.modelShort, 'Sonnet');
      assert.equal(config.resolvedModel, null);
    });
  });
});

test('observed alias resolution updates the picker and selected model display', async () => {
  await withModelCache(async () => {
    await recordClaudeResolvedModel('fable', 'claude-fable-5-1-20260913');
    await recordClaudeResolvedModel('sonnet', 'claude-sonnet-5-20260820');

    await withEnv('CODEXMOBILE_CLAUDE_MODEL', 'fable', async () => {
      const config = await readClaudeConfig();
      const byValue = new Map(config.models.map((m) => [m.value, m]));
      assert.deepEqual(byValue.get('fable'), {
        value: 'fable',
        label: 'Claude Fable 5.1',
        resolvedModel: 'claude-fable-5-1-20260913'
      });
      assert.equal(config.modelShort, 'Fable 5.1');
      assert.equal(config.resolvedModel, 'claude-fable-5-1-20260913');
      assert.equal(byValue.get('sonnet').label, 'Claude Sonnet 5');
    });
  });
});

test('alias cache ignores mismatched families and arbitrary model strings', async () => {
  await withModelCache(async () => {
    assert.equal(await recordClaudeResolvedModel('fable', 'claude-sonnet-5-1-20260913'), false);
    assert.equal(await recordClaudeResolvedModel('gpt-5.6', 'claude-fable-5-1-20260913'), false);
    const config = await readClaudeConfig();
    assert.equal(config.models.find((m) => m.value === 'fable').resolvedModel, null);
  });
});

test('CODEXMOBILE_CLAUDE_MODELS overrides the picker and auto-labels full ids', async () => {
  await withModelCache(async () => {
    await withEnv('CODEXMOBILE_CLAUDE_MODELS', 'opus, claude-fable-5-1-20260913, claude-sonnet-6-1, sonnet', async () => {
      const config = await readClaudeConfig();
      assert.deepEqual(
        config.models.map((m) => m.value),
        ['opus', 'claude-fable-5-1-20260913', 'claude-sonnet-6-1', 'sonnet']
      );
      const fable = config.models.find((m) => m.value === 'claude-fable-5-1-20260913');
      assert.equal(fable.label, 'Claude Fable 5.1');
      assert.equal(fable.resolvedModel, 'claude-fable-5-1-20260913');
      const future = config.models.find((m) => m.value === 'claude-sonnet-6-1');
      assert.equal(future.label, 'Claude Sonnet 6.1');
      assert.equal(future.resolvedModel, 'claude-sonnet-6-1');
    });
  });
});
