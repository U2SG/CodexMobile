import assert from 'node:assert/strict';
import test from 'node:test';

import { createBackoff } from './ws-backoff.js';

test('createBackoff returns initial delay on first call without jitter', () => {
  const backoff = createBackoff({ initial: 500, max: 30000, multiplier: 2, jitter: 0 });
  assert.equal(backoff.next(), 500);
  assert.equal(backoff.next(), 1000);
  assert.equal(backoff.next(), 2000);
  assert.equal(backoff.next(), 4000);
});

test('createBackoff caps at max', () => {
  const backoff = createBackoff({ initial: 1000, max: 5000, multiplier: 2, jitter: 0 });
  assert.equal(backoff.next(), 1000);
  assert.equal(backoff.next(), 2000);
  assert.equal(backoff.next(), 4000);
  assert.equal(backoff.next(), 5000);
  assert.equal(backoff.next(), 5000);
});

test('createBackoff with jitter stays within ±jitter band', () => {
  const backoff = createBackoff({ initial: 1000, max: 30000, multiplier: 2, jitter: 0.25 });
  // random=0 → offset = -25% ; random=1 → offset = +25%
  assert.equal(backoff.next(() => 0), 750);
  backoff.reset();
  assert.equal(backoff.next(() => 1), 1250);
  backoff.reset();
  assert.equal(backoff.next(() => 0.5), 1000);
});

test('createBackoff reset clears attempt counter', () => {
  const backoff = createBackoff({ initial: 500, max: 30000, multiplier: 2, jitter: 0 });
  backoff.next();
  backoff.next();
  backoff.next();
  assert.equal(backoff.attempts, 3);
  backoff.reset();
  assert.equal(backoff.attempts, 0);
  assert.equal(backoff.next(), 500);
});

test('createBackoff never returns negative values even with extreme jitter', () => {
  const backoff = createBackoff({ initial: 100, max: 30000, multiplier: 2, jitter: 1 });
  for (let i = 0; i < 50; i += 1) {
    backoff.reset();
    const delay = backoff.next(() => 0); // worst-case negative offset
    assert.ok(delay >= 0, `delay must be non-negative, got ${delay}`);
  }
});

test('createBackoff uses defaults when no options given', () => {
  const backoff = createBackoff();
  // first attempt should be roughly initial (500) ± 25%
  const delay = backoff.next(() => 0.5);
  assert.equal(delay, 500);
});
