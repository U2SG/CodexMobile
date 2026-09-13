// vitest + jsdom smoke for the TurnGroup card — collapsible process
// section + prominent conclusion + one action row. ChatPane delegates
// any multi-message turn to this component; single-message turns stay
// on the plain ChatMessage path.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  if (typeof window.DOMMatrix === 'undefined') {
    class DOMMatrixStub {
      constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; }
      multiply() { return this; }
      translate() { return this; }
      scale() { return this; }
      invertSelf() { return this; }
    }
    window.DOMMatrix = DOMMatrixStub;
    globalThis.DOMMatrix = DOMMatrixStub;
  }
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
  }
});

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

const agentStub = {
  id: 'claude',
  shortLabel: 'C',
  accentClass: 'is-claude',
  emptyTitle: '',
  emptyBody: ''
};

async function renderPane(messages) {
  const { ChatPane } = await import('./ChatPane.jsx');
  await act(async () => {
    root.render(
      <ChatPane
        messages={messages}
        agent={agentStub}
        onPreviewImage={() => {}}
        onDeleteMessage={() => {}}
      />
    );
  });
}

describe('TurnGroup — multi-segment assistant turn renders as one card', () => {
  test('multi-segment turn → ONE .turn-card with author + toggle + conclusion + actions', async () => {
    await renderPane([
      { id: 'a1', role: 'assistant', content: 'thinking step 1', turnId: 't1' },
      { id: 'act', role: 'activity', content: 'ran a tool', turnId: 't1', status: 'completed' },
      { id: 'a2', role: 'assistant', content: 'final answer here', turnId: 't1' }
    ]);
    const cards = container.querySelectorAll('.turn-card');
    expect(cards.length).toBe(1);
    const card = cards[0];
    expect(card.querySelector('.turn-card-author')?.textContent).toBe('C');
    expect(card.querySelector('.turn-process-toggle')).not.toBeNull();
    expect(card.querySelector('.turn-conclusion')?.textContent).toContain('final answer here');
    expect(card.querySelector('.message-actions')).not.toBeNull();
  });

  test('conclusion (last assistant text) is always visible regardless of collapse state', async () => {
    await renderPane([
      { id: 'a1', role: 'assistant', content: 'mid-turn', turnId: 't1' },
      { id: 'a2', role: 'assistant', content: 'CONCLUSION_MARK', turnId: 't1' }
    ]);
    // Collapsed by default (no activity running). Conclusion still shows.
    expect(container.textContent).toContain('CONCLUSION_MARK');
    // Process body NOT in the DOM when collapsed.
    expect(container.querySelector('.turn-process-body')).toBeNull();
  });

  test('process body is hidden by default when no activity is running (turn complete)', async () => {
    await renderPane([
      { id: 'a1', role: 'assistant', content: 'thinking', turnId: 't1' },
      { id: 'act', role: 'activity', content: 'tool ran', turnId: 't1', status: 'completed' },
      { id: 'a2', role: 'assistant', content: 'final', turnId: 't1' }
    ]);
    expect(container.querySelector('.turn-process-body')).toBeNull();
    // Thinking content is hidden too.
    expect(container.textContent).not.toContain('thinking');
  });

  test('process body is OPEN by default when any activity is running (turn in flight)', async () => {
    await renderPane([
      { id: 'a1', role: 'assistant', content: 'thinking', turnId: 't1' },
      { id: 'act', role: 'activity', content: 'tool', turnId: 't1', status: 'running' },
      { id: 'a2', role: 'assistant', content: 'partial', turnId: 't1' }
    ]);
    expect(container.querySelector('.turn-process-body')).not.toBeNull();
    expect(container.textContent).toContain('thinking');
    // Toggle should reflect open state.
    const toggle = container.querySelector('.turn-process-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  test('clicking the toggle expands a collapsed process body and shows step content', async () => {
    await renderPane([
      { id: 'a1', role: 'assistant', content: 'hidden mid-turn text', turnId: 't1' },
      { id: 'a2', role: 'assistant', content: 'final', turnId: 't1' }
    ]);
    expect(container.querySelector('.turn-process-body')).toBeNull();
    const toggle = container.querySelector('.turn-process-toggle');
    await act(async () => { toggle.click(); });
    expect(container.querySelector('.turn-process-body')).not.toBeNull();
    expect(container.textContent).toContain('hidden mid-turn text');
  });

  test('toggle step count matches process length', async () => {
    await renderPane([
      { id: 'a1', role: 'assistant', content: 'one', turnId: 't1' },
      { id: 'act1', role: 'activity', content: '', turnId: 't1', status: 'completed' },
      { id: 'a2', role: 'assistant', content: 'two', turnId: 't1' },
      { id: 'act2', role: 'activity', content: '', turnId: 't1', status: 'completed' },
      { id: 'a3', role: 'assistant', content: 'conclusion', turnId: 't1' }
    ]);
    // process = a1, act1, a2, act2 = 4 steps; conclusion = a3
    const label = container.querySelector('.turn-process-label')?.textContent || '';
    expect(label).toContain('4');
  });

  test('single-message turn still renders as plain ChatMessage (no TurnGroup card)', async () => {
    await renderPane([
      { id: 'u1', role: 'user', content: 'a question', turnId: 't1' },
      { id: 'a1', role: 'assistant', content: 'a short reply', turnId: 't2' }
    ]);
    expect(container.querySelector('.turn-card')).toBeNull();
    // Both single-message turns render normally.
    expect(container.querySelectorAll('.message-row.is-user').length).toBe(1);
    expect(container.querySelectorAll('.message-row.is-assistant').length).toBe(1);
  });

  test('user message sharing the turn id renders as its own bubble, never inside the card', async () => {
    await renderPane([
      { id: 'u1', role: 'user', content: 'a question', turnId: 't1' },
      { id: 'a1', role: 'assistant', content: 'thinking', turnId: 't1' },
      { id: 'act', role: 'activity', content: 'ran a tool', turnId: 't1', status: 'completed' },
      { id: 'a2', role: 'assistant', content: 'final answer', turnId: 't1' }
    ]);
    // One standalone user bubble.
    expect(container.querySelectorAll('.message-row.is-user').length).toBe(1);
    // One assistant card for the multi-segment reply.
    const cards = container.querySelectorAll('.turn-card');
    expect(cards.length).toBe(1);
    // The user text must NOT appear inside the card.
    expect(cards[0].textContent).not.toContain('a question');
  });

  test('messages without turnId stay as standalone ChatMessages (no grouping)', async () => {
    await renderPane([
      { id: 'a1', role: 'assistant', content: 'r1' },
      { id: 'a2', role: 'assistant', content: 'r2' }
    ]);
    expect(container.querySelector('.turn-card')).toBeNull();
    expect(container.querySelectorAll('.message-row.is-assistant').length).toBe(2);
  });
});
