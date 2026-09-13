import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  SEED_PROMPTS,
  getStoredPrompts,
  recordPromptUse,
  pinPrompt,
  unpinPrompt,
  filteredQuickPrompts
} from './quick-prompts.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    _map: map
  };
}

test('first read returns seed pinned prompts and empty recent', () => {
  const storage = memoryStorage();
  const state = getStoredPrompts(storage);
  assert.equal(state.pinned.length, SEED_PROMPTS.length);
  assert.equal(state.recent.length, 0);
  assert.equal(state.pinned[0].id, SEED_PROMPTS[0].id);
});

test('after a recordPromptUse, the entry shows up most-recent in recent', () => {
  const storage = memoryStorage();
  const after = recordPromptUse('quick test prompt', storage);
  assert.equal(after.recent.length, 1);
  assert.equal(after.recent[0].prompt, 'quick test prompt');
  assert.ok(typeof after.recent[0].usedAt === 'number');
});

test('recordPromptUse de-dupes existing recent entries and floats to top', () => {
  const storage = memoryStorage();
  recordPromptUse('a', storage);
  recordPromptUse('b', storage);
  recordPromptUse('a', storage); // reuse a — should float
  const state = getStoredPrompts(storage);
  assert.deepEqual(state.recent.map((r) => r.prompt), ['a', 'b']);
});

test('recordPromptUse caps recent at 20', () => {
  const storage = memoryStorage();
  for (let i = 0; i < 25; i += 1) {
    recordPromptUse(`p${i}`, storage);
  }
  const state = getStoredPrompts(storage);
  assert.equal(state.recent.length, 20);
  // Most recent is the last inserted (p24).
  assert.equal(state.recent[0].prompt, 'p24');
});

test('recordPromptUse with empty string is a no-op', () => {
  const storage = memoryStorage();
  recordPromptUse('   ', storage);
  recordPromptUse('', storage);
  const state = getStoredPrompts(storage);
  assert.equal(state.recent.length, 0);
});

test('pinPrompt prepends to pinned and removes from recent', () => {
  const storage = memoryStorage();
  recordPromptUse('xyz', storage);
  const after = pinPrompt({ id: 'user-1', label: 'My Pin', prompt: 'xyz' }, storage);
  assert.equal(after.pinned[0].id, 'user-1');
  assert.equal(after.pinned[0].label, 'My Pin');
  assert.equal(after.pinned[0].prompt, 'xyz');
  assert.ok(!after.recent.some((r) => r.prompt === 'xyz'));
});

test('pinPrompt without a label derives one from the prompt text', () => {
  const storage = memoryStorage();
  const long = 'this is a long prompt that should get truncated for the label';
  const after = pinPrompt({ id: 'auto', prompt: long }, storage);
  assert.equal(after.pinned[0].label.length, 24);
});

test('pinPrompt replaces an existing pin with the same id', () => {
  const storage = memoryStorage();
  pinPrompt({ id: 'edit-me', label: 'old', prompt: 'old prompt' }, storage);
  const after = pinPrompt({ id: 'edit-me', label: 'new', prompt: 'new prompt' }, storage);
  const matches = after.pinned.filter((p) => p.id === 'edit-me');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].label, 'new');
});

test('unpinPrompt removes the pin by id', () => {
  const storage = memoryStorage();
  const seedId = SEED_PROMPTS[0].id;
  const before = getStoredPrompts(storage);
  assert.ok(before.pinned.some((p) => p.id === seedId));
  const after = unpinPrompt(seedId, storage);
  assert.ok(!after.pinned.some((p) => p.id === seedId));
});

test('filteredQuickPrompts: empty query returns the original lists', () => {
  const state = { pinned: [{ id: '1', label: 'a', prompt: 'foo' }], recent: [{ prompt: 'bar', usedAt: 1 }] };
  const result = filteredQuickPrompts('', state);
  assert.equal(result.pinned.length, 1);
  assert.equal(result.recent.length, 1);
});

test('filteredQuickPrompts: query matches both label and prompt text', () => {
  const state = {
    pinned: [
      { id: '1', label: 'Code review', prompt: 'please review' },
      { id: '2', label: '总结', prompt: 'summarize the conversation' }
    ],
    recent: [
      { prompt: 'fix the bug', usedAt: 1 },
      { prompt: 'add tests', usedAt: 2 }
    ]
  };
  const r1 = filteredQuickPrompts('review', state);
  assert.equal(r1.pinned.length, 1);
  assert.equal(r1.pinned[0].id, '1');
  const r2 = filteredQuickPrompts('summarize', state);
  assert.equal(r2.pinned.length, 1);
  assert.equal(r2.pinned[0].id, '2');
  const r3 = filteredQuickPrompts('bug', state);
  assert.equal(r3.recent.length, 1);
});

test('filteredQuickPrompts: case-insensitive', () => {
  const state = { pinned: [{ id: '1', label: 'REVIEW', prompt: 'x' }], recent: [] };
  const r = filteredQuickPrompts('review', state);
  assert.equal(r.pinned.length, 1);
});

test('getStoredPrompts tolerates corrupted JSON', () => {
  const storage = memoryStorage();
  storage.setItem('codexmobile.quickPrompts', '{not valid json');
  const state = getStoredPrompts(storage);
  // Falls back to seed defaults instead of throwing.
  assert.equal(state.pinned.length, SEED_PROMPTS.length);
});

test('explicit empty state after bootstrap is preserved (not re-seeded)', () => {
  const storage = memoryStorage();
  // Unpin every seed to get an empty pinned list.
  let state = getStoredPrompts(storage);
  for (const entry of state.pinned) {
    state = unpinPrompt(entry.id, storage);
  }
  // Re-read — should NOT regenerate seeds, because saveStoredPrompts
  // wrote bootstrapped: true.
  state = getStoredPrompts(storage);
  assert.equal(state.pinned.length, 0);
});
