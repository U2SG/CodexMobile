import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { liveEnv, parseEnvFile } from './env-file.js';

test('parseEnvFile handles comments, blanks, quotes and =-in-value', () => {
  const values = parseEnvFile([
    '# comment',
    '',
    'PLAIN=hello',
    'QUOTED="a, b, c"',
    'SINGLE=\'x\'',
    'WITH_EQ=base64==',
    '  SPACED = padded  ',
    'NOKEY',
    '=novalue'
  ].join('\n'));
  assert.equal(values.get('PLAIN'), 'hello');
  assert.equal(values.get('QUOTED'), 'a, b, c');
  assert.equal(values.get('SINGLE'), 'x');
  assert.equal(values.get('WITH_EQ'), 'base64==');
  assert.equal(values.get('SPACED'), 'padded');
  assert.equal(values.has('NOKEY'), false);
  assert.equal(values.has(''), false);
});

test('liveEnv picks up an edit to the file and falls back to process.env', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-env-'));
  const envPath = path.join(dir, '.env');
  try {
    await fs.writeFile(envPath, 'CODEXMOBILE_TEST_KEY=first\n', 'utf8');
    assert.equal(await liveEnv('CODEXMOBILE_TEST_KEY', envPath), 'first');

    // Force a distinct mtime so the cache invalidates.
    await fs.writeFile(envPath, 'CODEXMOBILE_TEST_KEY=second\n', 'utf8');
    await fs.utimes(envPath, new Date(), new Date(Date.now() + 5000));
    assert.equal(await liveEnv('CODEXMOBILE_TEST_KEY', envPath), 'second');

    process.env.CODEXMOBILE_TEST_FALLBACK = 'from-process';
    try {
      assert.equal(await liveEnv('CODEXMOBILE_TEST_FALLBACK', envPath), 'from-process');
    } finally {
      delete process.env.CODEXMOBILE_TEST_FALLBACK;
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
