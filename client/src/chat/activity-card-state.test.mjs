import assert from 'node:assert/strict';
import test from 'node:test';
import { activityCardShouldOpen } from './activity-card-state.js';

test('activity card stays compact by default', () => {
  assert.equal(activityCardShouldOpen({ running: true, hasProcess: true }), false);
  assert.equal(activityCardShouldOpen({ running: false, hasProcess: true }), false);
  assert.equal(activityCardShouldOpen({ running: true, hasProcess: false }), false);
});
