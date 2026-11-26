import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  agyTranscriptPath,
  buildAgyModelList,
  extractAgyUserText,
  formatAgyModelLabel,
  normalizeAgyTimestamp,
  parseWorkspaceUris,
  queryAgyConversationSummaries,
  readAgyConfig
} from './agy-config.js';

test('parseWorkspaceUris decodes file:// URIs and deduplicates paths', () => {
  const firstDir = path.resolve(os.tmpdir(), 'demo-repo');
  const secondDir = path.resolve(os.tmpdir(), 'second-repo');
  const firstUri = pathToFileURL(firstDir).href;
  const raw = JSON.stringify([firstUri, firstUri, secondDir]);
  const paths = parseWorkspaceUris(raw);
  assert.equal(paths.length, 2);
  assert.equal(paths[0], firstDir);
  assert.equal(paths[1], secondDir);
});

test('extractAgyUserText unwraps USER_REQUEST and strips metadata blocks', () => {
  const wrapped = [
    '<USER_REQUEST>',
    'Add AGY support',
    '</USER_REQUEST>',
    '<ADDITIONAL_METADATA>',
    'The current local time is: 2026-11-26T09:00:00+08:00.',
    '</ADDITIONAL_METADATA>'
  ].join('\n');
  assert.equal(extractAgyUserText(wrapped), 'Add AGY support');

  const fallback = 'Plain prompt\n<USER_SETTINGS_CHANGE>changed</USER_SETTINGS_CHANGE>';
  assert.equal(extractAgyUserText(fallback), 'Plain prompt');
});

test('normalizeAgyTimestamp handles Go SQLite timestamps and rejects zero dates', () => {
  assert.equal(normalizeAgyTimestamp('0001-01-01 00:00:00+00:00'), null);
  assert.equal(
    normalizeAgyTimestamp('2026-11-25 14:15:49.33987+00:00'),
    '2026-11-25T14:15:49.339Z'
  );
});

test('buildAgyModelList formats labels and preserves custom overrides', () => {
  const defaults = buildAgyModelList('', 'gemini-4-neon-high');
  assert.ok(defaults.some((m) => m.value === 'gemini-4-neon-high' && m.label === 'Gemini 4 Neon (High)'));

  const custom = buildAgyModelList('gemini-4-neon-high,custom-model-xhigh', 'custom-active');
  assert.deepEqual(
    custom.map((m) => m.value),
    ['custom-active', 'gemini-4-neon-high', 'custom-model-xhigh']
  );
  assert.equal(formatAgyModelLabel('custom-model-xhigh'), 'Custom Model (XHigh)');
});

test('agyTranscriptPath builds canonical transcript location', () => {
  const p = agyTranscriptPath('conv-123', '/tmp/agy-home');
  assert.equal(
    p,
    path.join('/tmp/agy-home', 'brain', 'conv-123', '.system_generated', 'logs', 'transcript.jsonl')
  );
});

test('queryAgyConversationSummaries and readAgyConfig filter subagents and empty rows', async () => {
  let sqlite = null;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    return;
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-config-test-'));
  const dbPath = path.join(tmpDir, 'conversation_summaries.db');
  const alphaDir = path.resolve(tmpDir, 'project-alpha');
  const emptyDir = path.resolve(tmpDir, 'project-empty');
  const fallbackDir = path.resolve(tmpDir, 'fallback-cwd');
  const alphaUris = JSON.stringify([pathToFileURL(alphaDir).href]);
  const emptyUris = JSON.stringify([pathToFileURL(emptyDir).href]);
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id text PRIMARY KEY,
        title text NOT NULL DEFAULT "",
        preview text NOT NULL DEFAULT "",
        step_count integer NOT NULL DEFAULT 0,
        last_modified_time datetime NOT NULL,
        workspace_uris text NOT NULL,
        status text NOT NULL DEFAULT "",
        source text NOT NULL DEFAULT "",
        parent_conversation_id text NOT NULL DEFAULT "",
        nesting_depth integer NOT NULL DEFAULT 0,
        last_user_input_time datetime NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO conversation_summaries
      (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, source, parent_conversation_id, nesting_depth, last_user_input_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      'conv-top',
      'Top Conversation',
      'First message',
      12,
      '2026-11-25 14:15:49+00:00',
      alphaUris,
      'CASCADE_RUN_STATUS_IDLE',
      '',
      '',
      0,
      '2026-11-25 14:15:00+00:00'
    );
    insert.run(
      'conv-child',
      'Subagent Child',
      'Child work',
      4,
      '2026-11-25 14:16:00+00:00',
      alphaUris,
      'CASCADE_RUN_STATUS_IDLE',
      '',
      'conv-top',
      1,
      '2026-11-25 14:16:00+00:00'
    );
    insert.run(
      'conv-empty',
      '',
      '',
      0,
      '0001-01-01 00:00:00+00:00',
      emptyUris,
      'CASCADE_RUN_STATUS_IDLE',
      '',
      '',
      0,
      '0001-01-01 00:00:00+00:00'
    );
  } finally {
    db.close();
  }

  try {
    const rows = await queryAgyConversationSummaries(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'conv-top');
    assert.equal(rows[0].title, 'Top Conversation');
    assert.equal(rows[0].cwd, alphaDir);

    const cfg = await readAgyConfig({ dbPath, cwd: fallbackDir });
    assert.equal(cfg.provider, 'agy');
    assert.ok(cfg.projects.some((p) => p.path === alphaDir));
    assert.ok(cfg.projects.some((p) => p.path === fallbackDir));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
