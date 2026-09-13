import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activityBodyItemsForDisplay,
  activityStepDetailTitle,
  buildActivityTimeline,
  isSkillActivityStep
} from './chat/activity-timeline-model.js';

test('activity body keeps tool steps without detail when mixed with detailed steps', () => {
  const commandStep = {
    id: 'command',
    type: 'command',
    label: '运行命令',
    detail: 'npm test'
  };
  const toolStep = {
    id: 'tool',
    type: 'tool',
    label: '执行操作',
    detail: ''
  };
  const planStep = {
    id: 'plan',
    type: 'plan',
    label: '更新计划',
    detail: ''
  };

  const { visibleBodyItems } = activityBodyItemsForDisplay([commandStep, toolStep, planStep], []);

  assert.deepEqual(
    visibleBodyItems.map((item) => item.id),
    ['command', 'tool', 'plan']
  );
});

test('activity timeline keeps tool batches next to their matching commentary', () => {
  const timeline = buildActivityTimeline([
    {
      id: 'commentary-1',
      kind: 'agent_message',
      label: '先看状态。'
    },
    {
      id: 'command-1',
      kind: 'command_execution',
      label: '本地任务已处理',
      command: 'git status --short',
      status: 'completed'
    },
    {
      id: 'commentary-2',
      kind: 'agent_message',
      label: '再跑构建。'
    },
    {
      id: 'command-2',
      kind: 'command_execution',
      label: '本地任务已处理',
      command: 'npm run build',
      status: 'completed'
    }
  ], false);

  assert.deepEqual(
    timeline.map((item) => item.type),
    ['text', 'meta', 'text', 'meta']
  );
  assert.equal(timeline[1].items[0].command, 'git status --short');
  assert.equal(timeline[3].items[0].command, 'npm run build');
});

test('activity step detail titles describe read and search commands semantically', () => {
  const timeline = buildActivityTimeline([
    {
      id: 'read-1',
      kind: 'command_execution',
      label: '本地任务已处理',
      command: "sed -n '1,220p' /Users/xiayanghui/编程项目/CodexMobile/client/src/App.jsx",
      status: 'completed'
    },
    {
      id: 'search-1',
      kind: 'command_execution',
      label: '本地任务已处理',
      command: 'rg -n "completedSessionIds|markSessionCompleteNotice" client/src/app',
      status: 'completed'
    }
  ], false);

  assert.equal(timeline[0].items[0].type, 'explore');
  assert.equal(activityStepDetailTitle(timeline[0].items[0]), '读取 client/src/App.jsx');
  assert.equal(timeline[0].items[1].type, 'search');
  assert.equal(activityStepDetailTitle(timeline[0].items[1]), '搜索 completedSessionIds|markSessionCompleteNotice');
});

test('single command activity uses desktop-style run title', () => {
  const timeline = buildActivityTimeline([
    {
      id: 'command-1',
      kind: 'command_execution',
      label: '本地任务已处理',
      command: 'npm run build',
      status: 'completed'
    }
  ], false);

  assert.equal(timeline[0].title, '已运行 npm run build');
  assert.equal(activityStepDetailTitle(timeline[0].items[0]), '已运行 npm run build');
});

test('plan implementation activity stays actionable in the timeline model', () => {
  const timeline = buildActivityTimeline([
    {
      id: 'implement-plan:turn-1',
      kind: 'plan_implementation',
      label: '等待确认执行计划',
      detail: '1. 定位同步链路',
      status: 'running',
      planImplementation: {
        requestId: 'implement-plan:turn-1',
        turnId: 'turn-1',
        planContent: '1. 定位同步链路',
        completed: false
      }
    }
  ], false);

  assert.equal(timeline[0].items[0].type, 'plan_implementation');
  assert.equal(timeline[0].title, '等待确认执行计划');
  assert.deepEqual(timeline[0].items[0].planImplementation, {
    requestId: 'implement-plan:turn-1',
    turnId: 'turn-1',
    planContent: '1. 定位同步链路',
    completed: false
  });
});

test('skill reads use skill names instead of raw SKILL.md paths', () => {
  const timeline = buildActivityTimeline([
    {
      id: 'skill-1',
      kind: 'command_execution',
      label: '本地任务已处理',
      command: "sed -n '1,180p' /Users/xiayanghui/.codex/plugins/cache/openai-curated/superpowers/f812c146/skills/verification-before-completion/SKILL.md",
      status: 'completed'
    }
  ], false);

  assert.equal(timeline[0].title, '读取 Verification Before Completion 技能');
  assert.equal(activityStepDetailTitle(timeline[0].items[0]), '读取 Verification Before Completion 技能');
  assert.equal(isSkillActivityStep(timeline[0].items[0]), true);
});

test('activity timeline counts command actions instead of paths found in output', () => {
  const timeline = buildActivityTimeline([
    {
      id: 'search-1',
      kind: 'command_execution',
      label: '本地任务已处理',
      command: 'rg -n "markSessionCompleteNotice" client/src',
      output: 'client/src/app/App.jsx:1:markSessionCompleteNotice\nclient/src/app/useTurnRuntime.js:2:markSessionCompleteNotice',
      status: 'completed'
    },
    {
      id: 'read-1',
      kind: 'command_execution',
      label: '本地任务已处理',
      command: "sed -n '1,80p' client/src/app/App.jsx",
      output: "import x from './useTurnRuntime.js';",
      status: 'completed'
    }
  ], false);

  assert.equal(timeline[0].title, '已搜索 1 次，已探索 1 个文件');
});
