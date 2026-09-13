import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeActivityStep } from './activity-merge.js';

test('mergeActivityStep collapses duplicate thinking labels for one turn', () => {
  const current = mergeActivityStep([], {
    id: 'status-turn-1-reasoning-正在思考中',
    kind: 'reasoning',
    label: '正在思考中',
    status: 'running'
  });
  const next = mergeActivityStep(current, {
    id: 'status-turn-1-reasoning-正在思考',
    kind: 'reasoning',
    label: '正在思考',
    status: 'running'
  });

  assert.equal(next.length, 1);
  assert.equal(next[0].label, '正在思考');
});

test('mergeActivityStep keeps distinct narrative commentary steps', () => {
  const current = mergeActivityStep([], {
    id: 'message-1',
    kind: 'agent_message',
    label: '我先检查当前状态。',
    status: 'running'
  });
  const next = mergeActivityStep(current, {
    id: 'message-2',
    kind: 'agent_message',
    label: '当前已经进入后台执行。',
    status: 'running'
  });

  assert.equal(next.length, 2);
  assert.equal(next[0].label, '我先检查当前状态。');
  assert.equal(next[1].label, '当前已经进入后台执行。');
});

test('mergeActivityStep updates the same narrative commentary step by id', () => {
  const current = mergeActivityStep([], {
    id: 'message-1',
    kind: 'agent_message',
    label: '正在整理。',
    status: 'running'
  });
  const next = mergeActivityStep(current, {
    id: 'message-1',
    kind: 'agent_message',
    label: '已经整理完成。',
    status: 'completed'
  });

  assert.equal(next.length, 1);
  assert.equal(next[0].label, '已经整理完成。');
  assert.equal(next[0].status, 'completed');
});
