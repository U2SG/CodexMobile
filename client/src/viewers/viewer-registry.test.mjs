// Pure-JS tests for the registry primitives. The actual viewer
// components are JSX/React and exercised via App.smoke.test.jsx.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  registerViewer,
  resolveViewer,
  resolveViewerById,
  listViewers,
  _resetForTest
} from './viewer-registry.js';

afterEach(() => {
  _resetForTest();
});

function makeViewer(id, matchesFn) {
  return {
    id,
    matches: matchesFn,
    Component: () => null
  };
}

test('registerViewer enforces shape', () => {
  assert.throws(() => registerViewer(null), /must be an object/);
  assert.throws(() => registerViewer({}), /id .* required/);
  assert.throws(() => registerViewer({ id: 'x' }), /matches/);
  assert.throws(() => registerViewer({ id: 'x', matches: () => true }), /Component/);
});

test('registerViewer rejects duplicate ids', () => {
  registerViewer(makeViewer('dup', () => true));
  assert.throws(() => registerViewer(makeViewer('dup', () => true)), /already registered/);
});

test('resolveViewer returns null when nothing matches', () => {
  registerViewer(makeViewer('never', () => false));
  assert.equal(resolveViewer({ path: '/foo.bin' }), null);
});

test('resolveViewer returns the first matching viewer in registration order', () => {
  registerViewer(makeViewer('first', (p) => p.endsWith('.md')));
  registerViewer(makeViewer('second', () => true));
  const hit = resolveViewer({ path: '/x.md' });
  assert.equal(hit.id, 'first');
  const fallback = resolveViewer({ path: '/x.bin' });
  assert.equal(fallback.id, 'second');
});

test('resolveViewer matches on content type as well as path', () => {
  registerViewer(makeViewer('byContentType', (_p, t) => t.includes('markdown')));
  const hit = resolveViewer({ path: '/no-extension', contentType: 'text/markdown; charset=utf-8' });
  assert.equal(hit?.id, 'byContentType');
});

test('resolveViewerById is case-insensitive and returns null for unknown ids', () => {
  registerViewer(makeViewer('Image', () => false));
  assert.equal(resolveViewerById('image')?.id, 'Image');
  assert.equal(resolveViewerById('IMAGE')?.id, 'Image');
  assert.equal(resolveViewerById('nope'), null);
});

test('listViewers returns a snapshot copy (not the live array)', () => {
  registerViewer(makeViewer('a', () => true));
  const snapshot = listViewers();
  snapshot.push('mutated');
  assert.equal(listViewers().length, 1);
});

// Coverage for the shipped barrel + JSX viewers is in
// viewer-registry.smoke.test.jsx — vitest runs that under jsdom because
// the viewer Components are JSX and node:test can't transform them.
