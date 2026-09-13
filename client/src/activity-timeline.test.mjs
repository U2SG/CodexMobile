import assert from 'node:assert/strict';
import test from 'node:test';
import { isPlaceholderTimelineItem } from './activity-timeline.js';

test('isPlaceholderTimelineItem hides generic tool placeholders', () => {
  assert.equal(
    isPlaceholderTimelineItem({
      type: 'tool',
      label: '正在完成一步操作',
      detail: ''
    }),
    true
  );
});

test('isPlaceholderTimelineItem keeps concrete tool work', () => {
  assert.equal(
    isPlaceholderTimelineItem({
      type: 'tool',
      label: '正在完成一步操作',
      detail: '读取项目状态'
    }),
    false
  );
  assert.equal(
    isPlaceholderTimelineItem({
      type: 'search',
      label: '正在搜索',
      detail: ''
    }),
    false
  );
});
