// vitest + jsdom smoke for the per-turn grouping behavior of ChatPane +
// ChatMessage. ChatPane stamps each message with `turnPosition`
// (sole / first / middle / last); ChatMessage uses that to gate the
// author label (first/sole only) and the action row (last/sole only)
// so a multi-segment assistant turn — text → tool_use → text → tool_use
// → text — reads as one visually unified bubble with one author label
// at top and one action row at the bottom.

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
  accentClass: '',
  emptyTitle: 'New chat',
  emptyBody: 'Say hi'
};

async function renderMessage(extraProps = {}) {
  const { ChatMessage } = await import('./ChatMessage.jsx');
  const message = {
    id: 'msg-1',
    role: 'assistant',
    content: 'Hello world',
    timestamp: new Date().toISOString()
  };
  await act(async () => {
    root.render(
      <ChatMessage
        message={message}
        now={Date.now()}
        agent={agentStub}
        onDeleteMessage={() => {}}
        {...extraProps}
      />
    );
  });
}

describe('ChatMessage — turnPosition gates author label + action row', () => {
  test('turnPosition="sole" (default) renders both author label and actions', async () => {
    await renderMessage();
    expect(container.querySelector('.message-author')).not.toBeNull();
    expect(container.querySelector('.message-actions')).not.toBeNull();
  });

  test('turnPosition="first" renders author label but no actions', async () => {
    await renderMessage({ turnPosition: 'first' });
    expect(container.querySelector('.message-author')).not.toBeNull();
    expect(container.querySelector('.message-actions')).toBeNull();
  });

  test('turnPosition="middle" renders neither author nor actions', async () => {
    await renderMessage({ turnPosition: 'middle' });
    expect(container.querySelector('.message-author')).toBeNull();
    expect(container.querySelector('.message-actions')).toBeNull();
  });

  test('turnPosition="last" renders actions but no author label', async () => {
    await renderMessage({ turnPosition: 'last' });
    expect(container.querySelector('.message-author')).toBeNull();
    expect(container.querySelector('.message-actions')).not.toBeNull();
  });

  test('outer row carries data-turn-position attribute for CSS to consume', async () => {
    await renderMessage({ turnPosition: 'middle' });
    const row = container.querySelector('.message-row');
    expect(row.getAttribute('data-turn-position')).toBe('middle');
  });

  test('plan / activity messages do not get the ChatMessage gating (they have their own renderers)', async () => {
    await renderMessage({
      turnPosition: 'last',
      message: {
        id: 'plan-1',
        role: 'plan',
        content: '# A proposed plan',
        timestamp: new Date().toISOString()
      }
    });
    // PlanMessage takes over — no .message-actions from ChatMessage itself.
    expect(container.querySelector('.message-actions')).toBeNull();
  });
});

describe('ChatPane — single-segment turns render as plain ChatMessage with turnPosition="sole"', () => {
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

  test('user message + short assistant reply (different turns) stay as standalone rows', async () => {
    await renderPane([
      { id: 'u1', role: 'user', content: 'q', turnId: 't1', timestamp: new Date().toISOString() },
      { id: 'a1', role: 'assistant', content: 'a', turnId: 't2', timestamp: new Date().toISOString() }
    ]);
    // Both render as plain ChatMessage rows (no TurnGroup card).
    expect(container.querySelector('.turn-card')).toBeNull();
    const positions = [...container.querySelectorAll('.message-row')].map((r) => r.getAttribute('data-turn-position'));
    expect(positions).toEqual(['sole', 'sole']);
  });

  // Multi-segment turn coverage moved to TurnGroup.smoke.test.jsx — those
  // turns now route through <TurnGroup> instead of a chain of ChatMessages.
});
