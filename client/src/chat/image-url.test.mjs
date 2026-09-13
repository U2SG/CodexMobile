import assert from 'node:assert/strict';
import test from 'node:test';
import { imageUrlWithRetry } from './image-url.js';

test('imageUrlWithRetry returns the original url when retryKey is falsy', () => {
  assert.equal(imageUrlWithRetry('/api/local-image?path=a.png', 0), '/api/local-image?path=a.png');
  assert.equal(imageUrlWithRetry('/api/local-image?path=a.png', null), '/api/local-image?path=a.png');
  assert.equal(imageUrlWithRetry('/api/local-image?path=a.png', undefined), '/api/local-image?path=a.png');
});

test('imageUrlWithRetry appends r= using & when url already has a query string', () => {
  assert.equal(
    imageUrlWithRetry('/api/local-image?path=a.png', 1234),
    '/api/local-image?path=a.png&r=1234'
  );
});

test('imageUrlWithRetry appends r= using ? when url has no query string', () => {
  assert.equal(
    imageUrlWithRetry('/img/foo.png', 9999),
    '/img/foo.png?r=9999'
  );
});
