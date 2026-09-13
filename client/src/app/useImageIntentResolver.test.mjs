import assert from 'node:assert/strict';
import test from 'node:test';

import { interpretImageIntentResolution } from './useImageIntentResolver.js';

test('interpretImageIntentResolution cancels when mode is "cancel"', () => {
  assert.deepEqual(interpretImageIntentResolution('cancel'), { action: 'cancel' });
});

test('interpretImageIntentResolution submits with imageMode "force" when mode is "force"', () => {
  assert.deepEqual(interpretImageIntentResolution('force'), {
    action: 'submit',
    imageMode: 'force'
  });
});

test('interpretImageIntentResolution submits with imageMode "skip" when mode is "skip"', () => {
  assert.deepEqual(interpretImageIntentResolution('skip'), {
    action: 'submit',
    imageMode: 'skip'
  });
});

test('interpretImageIntentResolution defaults unknown modes to imageMode "skip"', () => {
  assert.deepEqual(interpretImageIntentResolution(''), {
    action: 'submit',
    imageMode: 'skip'
  });
  assert.deepEqual(interpretImageIntentResolution('something-else'), {
    action: 'submit',
    imageMode: 'skip'
  });
  assert.deepEqual(interpretImageIntentResolution(undefined), {
    action: 'submit',
    imageMode: 'skip'
  });
});
