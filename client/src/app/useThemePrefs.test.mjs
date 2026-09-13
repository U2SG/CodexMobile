import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_REASONING_EFFORT,
  REASONING_DEFAULT_VERSION,
  resolveInitialReasoningEffort
} from './useThemePrefs.js';

function makeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    snapshot: () => ({ ...data })
  };
}

test('resolveInitialReasoningEffort writes version + DEFAULT on first load', () => {
  const storage = makeStorage();
  assert.equal(resolveInitialReasoningEffort(storage), DEFAULT_REASONING_EFFORT);
  const snap = storage.snapshot();
  assert.equal(snap['codexmobile.reasoningDefaultVersion'], REASONING_DEFAULT_VERSION);
  assert.equal(snap['codexmobile.reasoningEffort'], DEFAULT_REASONING_EFFORT);
});

test('resolveInitialReasoningEffort overwrites saved value when version is stale', () => {
  const storage = makeStorage({
    'codexmobile.reasoningDefaultVersion': 'old-version',
    'codexmobile.reasoningEffort': 'low'
  });
  assert.equal(resolveInitialReasoningEffort(storage), DEFAULT_REASONING_EFFORT);
  assert.equal(storage.snapshot()['codexmobile.reasoningEffort'], DEFAULT_REASONING_EFFORT);
});

test('resolveInitialReasoningEffort preserves saved value when version matches', () => {
  const storage = makeStorage({
    'codexmobile.reasoningDefaultVersion': REASONING_DEFAULT_VERSION,
    'codexmobile.reasoningEffort': 'medium'
  });
  assert.equal(resolveInitialReasoningEffort(storage), 'medium');
});

test('resolveInitialReasoningEffort falls back to DEFAULT when version matches but no saved value', () => {
  const storage = makeStorage({
    'codexmobile.reasoningDefaultVersion': REASONING_DEFAULT_VERSION
  });
  assert.equal(resolveInitialReasoningEffort(storage), DEFAULT_REASONING_EFFORT);
});
