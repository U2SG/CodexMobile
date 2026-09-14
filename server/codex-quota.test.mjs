import test from 'node:test';
import assert from 'node:assert/strict';

import { selectCurrentCodexAuthEntry } from './codex-quota.js';

test('selectCurrentCodexAuthEntry prefers the one enabled ChatGPT credential', () => {
  const entries = [
    { name: 'codex-old.json', disabled: true },
    { name: 'codex-current.json', disabled: false },
    { name: 'codex-stale.json', disabled: true }
  ];
  assert.equal(selectCurrentCodexAuthEntry(entries)?.name, 'codex-current.json');
});

test('selectCurrentCodexAuthEntry falls back deterministically when all entries are disabled', () => {
  const entries = [
    { name: 'codex-a.json', disabled: true },
    { name: 'codex-b.json', disabled: true }
  ];
  assert.equal(selectCurrentCodexAuthEntry(entries)?.name, 'codex-a.json');
});

test('selectCurrentCodexAuthEntry returns null for no credentials', () => {
  assert.equal(selectCurrentCodexAuthEntry([]), null);
  assert.equal(selectCurrentCodexAuthEntry(null), null);
});
