import assert from 'node:assert/strict';
import test from 'node:test';

import { sendModeForRunningFollowup } from './useTurnSubmission.js';

test('sendModeForRunningFollowup steers only when the active task can be guided', () => {
  assert.equal(sendModeForRunningFollowup({ running: false, canGuideCurrentTask: true }), null);
  assert.equal(sendModeForRunningFollowup({ running: true, canGuideCurrentTask: true }), 'steer');
  assert.equal(sendModeForRunningFollowup({ running: true, canGuideCurrentTask: false }), 'queue');
});
