import assert from 'node:assert/strict';
import test from 'node:test';
import { emitCodexEvent } from './codex-runner.js';

function collect() {
  const events = [];
  const emit = (payload) => events.push(payload);
  return { events, emit };
}

test('agent_message item.updated emits partial assistant-update with done=false', () => {
  const { events, emit } = collect();
  const state = {};

  emitCodexEvent(
    {
      type: 'item.updated',
      item: { id: 'msg-1', type: 'agent_message', text: '正在', status: 'in_progress' }
    },
    'session-1',
    'turn-1',
    emit,
    state
  );

  const update = events.find((event) => event.type === 'assistant-update');
  assert.ok(update, 'expected an assistant-update emit');
  assert.equal(update.content, '正在');
  assert.equal(update.done, false);
  assert.equal(update.role, 'assistant');
  assert.equal(update.sessionId, 'session-1');
  assert.equal(update.turnId, 'turn-1');
  assert.equal(update.messageId, 'msg-1');
  assert.equal(state.hadAssistantText, true);
});

test('agent_message item.completed emits final assistant-update with done=true', () => {
  const { events, emit } = collect();
  const state = {};

  emitCodexEvent(
    {
      type: 'item.completed',
      item: { id: 'msg-2', type: 'agent_message', text: '完整回复内容', status: 'completed' }
    },
    'session-2',
    'turn-2',
    emit,
    state
  );

  const update = events.find((event) => event.type === 'assistant-update');
  assert.ok(update, 'expected an assistant-update emit');
  assert.equal(update.content, '完整回复内容');
  assert.equal(update.done, true);
  assert.equal(state.hadAssistantText, true);
});

test('agent_message empty text on item.updated does not emit assistant-update', () => {
  const { events, emit } = collect();

  emitCodexEvent(
    {
      type: 'item.updated',
      item: { id: 'msg-3', type: 'agent_message', text: '', status: 'in_progress' }
    },
    'session-3',
    'turn-3',
    emit,
    {}
  );

  const update = events.find((event) => event.type === 'assistant-update');
  assert.equal(update, undefined);
});

test('agent_message emits only assistant-update, not a redundant status label', () => {
  const { events, emit } = collect();

  emitCodexEvent(
    {
      type: 'item.updated',
      item: { id: 'msg-4', type: 'agent_message', text: 'hi there', status: 'in_progress' }
    },
    'session-4',
    'turn-4',
    emit,
    {}
  );

  const statusEvents = events.filter((event) => event.type === 'status-update');
  const update = events.find((event) => event.type === 'assistant-update');
  assert.ok(update, 'assistant-update should fire for streaming content');
  assert.equal(statusEvents.length, 0, 'no parallel status-update — assistant-update is the stream');
});

test('commentary item.updated emits status only, not assistant-update', () => {
  const { events, emit } = collect();

  emitCodexEvent(
    {
      type: 'item.updated',
      item: { id: 'cmt-1', type: 'message', phase: 'commentary', content: 'thinking out loud' }
    },
    'session-5',
    'turn-5',
    emit,
    {}
  );

  const status = events.find((event) => event.type === 'status-update');
  const update = events.find((event) => event.type === 'assistant-update');
  assert.ok(status, 'commentary should still emit status');
  assert.equal(update, undefined, 'commentary must not emit assistant-update');
});
