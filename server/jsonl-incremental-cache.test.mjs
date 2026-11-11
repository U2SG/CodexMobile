import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createJsonlIncrementalCache } from './jsonl-incremental-cache.js';

async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-cache-'));
  return path.join(dir, 'session.jsonl');
}

function collector() {
  let applied = 0;
  const cache = createJsonlIncrementalCache({
    createState: () => ({ rows: [] }),
    applyEntry: (state, entry) => {
      applied += 1;
      state.rows.push(entry.n);
    }
  });
  return { cache, applied: () => applied };
}

test('only parses rows appended since the previous read', async () => {
  const file = await tempFile();
  const { cache, applied } = collector();
  await fs.writeFile(file, '{"n":1}\n{"n":2}\n');
  assert.deepEqual((await cache.read(file)).rows, [1, 2]);

  await fs.appendFile(file, '{"n":3}\n');
  assert.deepEqual((await cache.read(file)).rows, [1, 2, 3]);
  assert.equal(applied(), 3);

  await cache.read(file);
  assert.equal(applied(), 3, 'unchanged file applies nothing');
});

test('leaves a half-written trailing row for the next read', async () => {
  const file = await tempFile();
  const { cache } = collector();
  await fs.writeFile(file, '{"n":1}\n{"n":');
  assert.deepEqual((await cache.read(file)).rows, [1]);

  await fs.appendFile(file, '2}\n');
  assert.deepEqual((await cache.read(file)).rows, [1, 2]);
});

test('consumes a complete trailing row without a newline exactly once', async () => {
  const file = await tempFile();
  const { cache } = collector();
  await fs.writeFile(file, '{"n":1}');
  assert.deepEqual((await cache.read(file)).rows, [1]);
  await fs.appendFile(file, '\n{"n":2}\n');
  assert.deepEqual((await cache.read(file)).rows, [1, 2]);
});

test('skips malformed rows and keeps multibyte text intact', async () => {
  const file = await tempFile();
  const cache = createJsonlIncrementalCache({
    createState: () => ({ rows: [] }),
    applyEntry: (state, entry) => state.rows.push(entry.text)
  });
  await fs.writeFile(file, `not json\n${JSON.stringify({ text: '你好'.repeat(40000) })}\n`);
  const { rows } = await cache.read(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0], '你好'.repeat(40000));
});

test('starts over when the file shrinks', async () => {
  const file = await tempFile();
  const { cache } = collector();
  await fs.writeFile(file, '{"n":1}\n{"n":2}\n');
  await cache.read(file);
  await fs.writeFile(file, '{"n":9}\n');
  assert.deepEqual((await cache.read(file)).rows, [9]);
});

test('concurrent reads never apply the same rows twice', async () => {
  const file = await tempFile();
  const { cache, applied } = collector();
  const rows = Array.from({ length: 500 }, (_, n) => JSON.stringify({ n })).join('\n');
  await fs.writeFile(file, `${rows}\n`);
  const states = await Promise.all([cache.read(file), cache.read(file), cache.read(file)]);
  assert.equal(applied(), 500);
  assert.equal(states[0].rows.length, 500);
});
