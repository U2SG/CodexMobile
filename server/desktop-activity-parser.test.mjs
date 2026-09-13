import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyRolloutCommandOutput,
  commandFromToolCallPayload,
  readRawSessionActivities,
  rolloutCommandActivity
} from './desktop-activity-parser.js';

test('raw session activity parser converts exec function calls into command activities', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-raw-activity-'));
  try {
    const filePath = path.join(dir, 'rollout.jsonl');
    await fs.writeFile(filePath, [
      JSON.stringify({
        timestamp: '2026-05-08T01:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '看一下状态' }]
        }
      }),
      JSON.stringify({
        timestamp: '2026-05-08T01:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'exec_command',
          arguments: JSON.stringify({ command: 'git status --short' })
        }
      }),
      JSON.stringify({
        timestamp: '2026-05-08T01:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: 'Process exited with code 0\nOutput:\nclean'
        }
      })
    ].join('\n'));

    const activities = await readRawSessionActivities(filePath, [
      { id: 'turn-1', startedAt: Date.parse('2026-05-08T01:00:00.000Z') / 1000 }
    ]);

    assert.equal(activities.length, 1);
    assert.equal(activities[0].turnId, 'turn-1');
    assert.equal(activities[0].segmentIndex, 0);
    assert.equal(activities[0].activity.kind, 'command_execution');
    assert.equal(activities[0].activity.status, 'completed');
    assert.equal(activities[0].activity.command, 'git status --short');
    assert.equal(activities[0].activity.output, 'clean');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('commandFromToolCallPayload reads codex 0.149 exec calls in both literal shapes', () => {
  const json = commandFromToolCallPayload({
    type: 'custom_tool_call',
    name: 'exec',
    input: 'const r = await tools.exec_command({"cmd":"git status --short","workdir":"D:\\repo"});'
  });
  assert.equal(json.command, 'git status --short');
  assert.equal(json.toolName, 'exec_command');

  // Same call emitted as a JS object literal with unquoted keys.
  const jsLiteral = commandFromToolCallPayload({
    type: 'custom_tool_call',
    name: 'exec',
    input: 'const r = await tools.exec_command({cmd: "rg -n \\"needle\\" src", yield_time_ms: 1000});'
  });
  assert.equal(jsLiteral.command, 'rg -n "needle" src');

  // Non-command tools stay out of the timeline.
  assert.equal(commandFromToolCallPayload({ type: 'function_call', name: 'wait', arguments: '{"cell_id":"2"}' }), null);
  assert.equal(commandFromToolCallPayload({ type: 'custom_tool_call', name: 'exec', input: 'tools.apply_patch(patch);' }), null);

  // Pre-0.149 shape still works.
  const legacy = commandFromToolCallPayload({
    type: 'function_call',
    name: 'exec_command',
    arguments: '{"command":"npm test"}'
  });
  assert.equal(legacy.command, 'npm test');
});

test('rolloutCommandActivity + applyRolloutCommandOutput fill in status and output', () => {
  const activity = rolloutCommandActivity(
    { type: 'custom_tool_call', name: 'exec', status: 'completed', input: 'await tools.exec_command({cmd:"ls"})' },
    { timestamp: '2026-09-01T01:00:00.000Z', turnId: 'turn-1', idSuffix: 'call-1' }
  );
  assert.equal(activity.kind, 'command_execution');
  assert.equal(activity.command, 'ls');

  applyRolloutCommandOutput(activity, {
    output: [{ type: 'input_text', text: 'Wall time 1s\nOutput:\nfile-a\nfile-b\nProcess exited with code 0' }]
  });
  assert.equal(activity.status, 'completed');
  assert.match(activity.output, /file-a/);
  assert.equal(activity.exitCode, 0);

  applyRolloutCommandOutput(activity, { output: 'Output:\nboom\nProcess exited with code 1' });
  assert.equal(activity.status, 'failed');
  assert.equal(activity.exitCode, 1);
});
