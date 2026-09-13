// Partial-stream parser for `claude -p --output-format=stream-json
// --include-partial-messages`. The CLI wraps Anthropic SSE events in
// {type:"stream_event", event:{...}, ...}; we accumulate text_delta payloads
// per content block and emit cumulative assistant-update frames (done=false).
// The trailing non-partial `assistant` event still fires and carries the final
// content with done=true, so we don't need a synthetic "done" emit here.

// The Anthropic message id (`msg_xxx`) is the only field that is stable
// across both the partial `stream_event` frames and the trailing non-partial
// `assistant` frame for the same logical message. `event.uuid` is a per-line
// envelope UUID added by the Claude CLI and differs across events, so using
// it as the messageId makes partial and final emits look like two distinct
// messages on the client.
export function claudeAssistantMessageId(event) {
  return event?.message?.id || event?.uuid || null;
}

export function createClaudePartialStreamState() {
  return {
    messageId: null,
    blocks: new Map(),
    hadPartialText: false
  };
}

export function processClaudePartialStreamEvent(line, state, emit, ctx) {
  if (!line || line.type !== 'stream_event' || !line.event) return;
  const inner = line.event;

  if (inner.type === 'message_start') {
    state.messageId = claudeAssistantMessageId(inner) || state.messageId;
    state.blocks = new Map();
    return;
  }

  if (inner.type === 'content_block_start' && typeof inner.index === 'number') {
    const initial = inner.content_block?.type === 'text' ? (inner.content_block?.text || '') : '';
    state.blocks.set(inner.index, initial);
    return;
  }

  if (inner.type === 'content_block_delta' && typeof inner.index === 'number') {
    const delta = inner.delta;
    if (delta?.type !== 'text_delta' || typeof delta.text !== 'string') return;
    const previous = state.blocks.get(inner.index) || '';
    const next = previous + delta.text;
    state.blocks.set(inner.index, next);
    state.hadPartialText = true;
    emit({
      type: 'assistant-update',
      sessionId: ctx?.sessionId || null,
      previousSessionId: ctx?.previousSessionId || null,
      turnId: ctx?.turnId || null,
      messageId: state.messageId,
      role: 'assistant',
      content: next,
      done: false,
      timestamp: new Date().toISOString()
    });
    return;
  }

  // content_block_stop / message_delta / message_stop: no-op (the trailing
  // non-partial `assistant` event in the parent loop carries the final
  // content + done:true).
}
