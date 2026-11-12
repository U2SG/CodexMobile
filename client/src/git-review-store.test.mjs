import assert from 'node:assert/strict';
import test from 'node:test';

import { loadReviewComments, saveReviewComments } from './git-review-store.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map
  };
}

test('round-trips comments per project and clears the key when empty', () => {
  const storage = memoryStorage();
  const comments = [{ id: 'c1', file: 'a.js', body: 'fix' }];
  saveReviewComments('p1', comments, storage);
  assert.deepEqual(loadReviewComments('p1', storage), comments);
  assert.deepEqual(loadReviewComments('p2', storage), []);
  saveReviewComments('p1', [], storage);
  assert.equal(storage.map.size, 0);
});

test('tolerates missing, corrupt or throwing storage', () => {
  assert.deepEqual(loadReviewComments('p1', null), []);
  const corrupt = memoryStorage();
  corrupt.setItem('codexmobile.reviewComments.p1', '{oops');
  assert.deepEqual(loadReviewComments('p1', corrupt), []);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() {} };
  assert.deepEqual(loadReviewComments('p1', throwing), []);
  assert.doesNotThrow(() => saveReviewComments('p1', [{ id: 'c', body: 'x' }], throwing));
});
