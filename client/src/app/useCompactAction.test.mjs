import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactErrorLabel,
  compactResultLabel
} from './useCompactAction.js';

test('compactErrorLabel reports the busy label when error mentions "running"', () => {
  assert.equal(
    compactErrorLabel('codex turn still running'),
    '任务进行中，请等待完成后再压缩'
  );
});

test('compactErrorLabel reports the busy label when error mentions "busy"', () => {
  assert.equal(
    compactErrorLabel('session busy'),
    '任务进行中，请等待完成后再压缩'
  );
});

test('compactErrorLabel reports the busy label when error mentions HTTP 409', () => {
  assert.equal(
    compactErrorLabel('HTTP 409 Conflict'),
    '任务进行中，请等待完成后再压缩'
  );
});

test('compactErrorLabel reports the generic retry label otherwise', () => {
  assert.equal(
    compactErrorLabel('unexpected server error'),
    '压缩失败，请重试'
  );
  assert.equal(compactErrorLabel(''), '压缩失败，请重试');
  assert.equal(compactErrorLabel(undefined), '压缩失败，请重试');
});

test('compactResultLabel reports the short-session label when compacted is exactly false', () => {
  assert.equal(compactResultLabel(false), '会话太短，无需压缩');
});

test('compactResultLabel reports the success label for true / undefined / other truthy values', () => {
  assert.equal(compactResultLabel(true), '会话已压缩');
  assert.equal(compactResultLabel(undefined), '会话已压缩');
  assert.equal(compactResultLabel(null), '会话已压缩');
  assert.equal(compactResultLabel({}), '会话已压缩');
});
