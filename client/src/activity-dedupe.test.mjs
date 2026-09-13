import test from 'node:test';
import assert from 'node:assert/strict';

import { removeDuplicateFinalAnswerActivity } from './activity-dedupe.js';

test('removes matching activity narration when the final answer is shown', () => {
  const messages = [
    {
      id: 'activity-1',
      role: 'activity',
      turnId: 'turn-1',
      activities: [
        { id: 'a', kind: 'agent_message', label: '我会先检查这个问题。' },
        { id: 'b', kind: 'command_execution', label: '读取文件', command: 'rg test' }
      ]
    }
  ];

  const result = removeDuplicateFinalAnswerActivity(messages, {
    turnId: 'turn-1',
    content: '我会先检查这个问题。'
  });

  assert.deepEqual(result[0].activities, [
    { id: 'b', kind: 'command_execution', label: '读取文件', command: 'rg test' }
  ]);
});

test('keeps non-matching activity narration', () => {
  const messages = [
    {
      id: 'activity-1',
      role: 'activity',
      turnId: 'turn-1',
      activities: [{ id: 'a', kind: 'agent_message', label: '我会先检查这个问题。' }]
    }
  ];

  const result = removeDuplicateFinalAnswerActivity(messages, {
    turnId: 'turn-1',
    content: '这里是最终结论。'
  });

  assert.equal(result[0].activities.length, 1);
});
