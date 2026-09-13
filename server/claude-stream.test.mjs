import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claudeAssistantMessageId,
  createClaudePartialStreamState,
  processClaudePartialStreamEvent
} from './claude-stream.js';

function collect() {
  const events = [];
  return { events, emit: (payload) => events.push(payload) };
}

test('content_block_delta with text_delta emits cumulative assistant-update done=false', () => {
  const { events, emit } = collect();
  const state = createClaudePartialStreamState();

  processClaudePartialStreamEvent(
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_a' } } },
    state,
    emit,
    { sessionId: 's1', turnId: 't1' }
  );
  processClaudePartialStreamEvent(
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    state,
    emit,
    { sessionId: 's1', turnId: 't1' }
  );
  processClaudePartialStreamEvent(
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } },
    state,
    emit,
    { sessionId: 's1', turnId: 't1' }
  );
  processClaudePartialStreamEvent(
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', world' } } },
    state,
    emit,
    { sessionId: 's1', turnId: 't1' }
  );

  const updates = events.filter((evt) => evt.type === 'assistant-update');
  assert.equal(updates.length, 2, 'two deltas → two assistant-update emits');
  assert.equal(updates[0].content, 'Hello');
  assert.equal(updates[0].done, false);
  assert.equal(updates[0].messageId, 'msg_a');
  assert.equal(updates[0].sessionId, 's1');
  assert.equal(updates[0].turnId, 't1');
  assert.equal(updates[1].content, 'Hello, world');
  assert.equal(updates[1].done, false);
  assert.equal(state.hadPartialText, true);
});

test('non-stream_event lines are ignored', () => {
  const { events, emit } = collect();
  const state = createClaudePartialStreamState();
  processClaudePartialStreamEvent(
    { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } },
    state,
    emit,
    { sessionId: 's', turnId: 't' }
  );
  assert.equal(events.length, 0);
});

test('non-text deltas (thinking, tool_use input) are skipped', () => {
  const { events, emit } = collect();
  const state = createClaudePartialStreamState();
  processClaudePartialStreamEvent(
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '...' } } },
    state,
    emit,
    { sessionId: 's', turnId: 't' }
  );
  processClaudePartialStreamEvent(
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"x":' } } },
    state,
    emit,
    { sessionId: 's', turnId: 't' }
  );
  assert.equal(events.length, 0);
});

test('separate content blocks have independent accumulators', () => {
  const { events, emit } = collect();
  const state = createClaudePartialStreamState();
  processClaudePartialStreamEvent(
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_b' } } },
    state, emit, { sessionId: 's', turnId: 't' }
  );
  processClaudePartialStreamEvent(
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Part0a' } } },
    state, emit, { sessionId: 's', turnId: 't' }
  );
  processClaudePartialStreamEvent(
    { type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Part2a' } } },
    state, emit, { sessionId: 's', turnId: 't' }
  );
  processClaudePartialStreamEvent(
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Part0b' } } },
    state, emit, { sessionId: 's', turnId: 't' }
  );
  const updates = events.filter((evt) => evt.type === 'assistant-update');
  assert.equal(updates.length, 3);
  assert.equal(updates[2].content, 'Part0aPart0b');
});

test('claudeAssistantMessageId prefers message.id over envelope uuid', () => {
  // Anthropic msg_xxx is stable across partial + final frames; event.uuid is
  // a per-line envelope id that differs between frames. Picking uuid first
  // would split one logical message into two bubbles on the client.
  assert.equal(
    claudeAssistantMessageId({ uuid: 'envelope-1', message: { id: 'msg_real' } }),
    'msg_real'
  );
  assert.equal(claudeAssistantMessageId({ uuid: 'envelope-2' }), 'envelope-2');
  assert.equal(claudeAssistantMessageId({}), null);
  assert.equal(claudeAssistantMessageId(null), null);
});

test('partial deltas and the trailing assistant frame share the same messageId', () => {
  // Same Anthropic message id appears in message_start (inner.message.id) and
  // the trailing non-partial `assistant` frame (event.message.id). Both call
  // sites must resolve to the same id so the streaming buffer's done flush
  // replaces the partial render instead of stacking a second bubble.
  const { events, emit } = collect();
  const state = createClaudePartialStreamState();

  processClaudePartialStreamEvent(
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_shared' } } },
    state, emit, { sessionId: 's', turnId: 't' }
  );
  processClaudePartialStreamEvent(
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } } },
    state, emit, { sessionId: 's', turnId: 't' }
  );

  const partialMessageId = events.find((evt) => evt.type === 'assistant-update').messageId;
  const finalMessageId = claudeAssistantMessageId({
    type: 'assistant',
    uuid: 'envelope-xyz',
    message: { id: 'msg_shared', content: [{ type: 'text', text: 'hello world' }] }
  });

  assert.equal(partialMessageId, 'msg_shared');
  assert.equal(finalMessageId, 'msg_shared');
});

test('message_start resets the accumulator and updates messageId', () => {
  const { events, emit } = collect();
  const state = createClaudePartialStreamState();
  processClaudePartialStreamEvent(
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_first' } } },
    state, emit, { sessionId: 's', turnId: 't' }
  );
  processClaudePartialStreamEvent(
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'one' } } },
    state, emit, { sessionId: 's', turnId: 't' }
  );
  processClaudePartialStreamEvent(
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_second' } } },
    state, emit, { sessionId: 's', turnId: 't' }
  );
  processClaudePartialStreamEvent(
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'two' } } },
    state, emit, { sessionId: 's', turnId: 't' }
  );
  const updates = events.filter((evt) => evt.type === 'assistant-update');
  assert.equal(updates.length, 2);
  assert.equal(updates[0].content, 'one');
  assert.equal(updates[0].messageId, 'msg_first');
  assert.equal(updates[1].content, 'two');
  assert.equal(updates[1].messageId, 'msg_second');
});
