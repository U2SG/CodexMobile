// vitest + jsdom smoke for the chat-message inline viewer path:
// recognizing ```viewer:<id> fenced blocks in assistant output and
// mounting the corresponding registered viewer in place of a plain
// code block.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;

beforeAll(() => {
  // PdfViewer transitively imports pdfjs-dist via the viewers barrel.
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
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function renderMessage(content) {
  const { MessageContent } = await import('./MessageContent.jsx');
  await act(async () => {
    root.render(<MessageContent content={content} isUser={false} />);
  });
}

describe('chat-message inline ```viewer:<id> fenced block', () => {
  test('renders MarkdownViewer for ```viewer:markdown', async () => {
    await renderMessage([
      'Here is what I found:',
      '',
      '```viewer:markdown',
      '# Heading',
      '',
      '**Bold** text inside a viewer block.',
      '```',
      '',
      'After.'
    ].join('\n'));
    // The viewer wrapper should be present and contain a real heading.
    const wrapper = container.querySelector('.message-inline-viewer');
    expect(wrapper).not.toBeNull();
    expect(wrapper.getAttribute('data-viewer-id')).toBe('markdown');
    expect(wrapper.querySelector('h1')?.textContent).toBe('Heading');
    expect(wrapper.querySelector('strong')?.textContent).toBe('Bold');
    // The text outside the fence still renders as ordinary markdown.
    expect(container.textContent).toContain('Here is what I found');
    expect(container.textContent).toContain('After.');
  });

  test('renders TextViewer (acceptsInline:true) as a <pre>', async () => {
    await renderMessage('```viewer:text\nplain\n  preserved   spaces\n```');
    const wrapper = container.querySelector('.message-inline-viewer[data-viewer-id="text"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper.querySelector('pre')?.textContent).toBe('plain\n  preserved   spaces');
  });

  test('unknown viewer id falls back to a code block (preserves the text)', async () => {
    await renderMessage('```viewer:nonexistent-viewer\nfallback payload\n```');
    expect(container.querySelector('.message-inline-viewer')).toBeNull();
    expect(container.textContent).toContain('fallback payload');
  });

  test('non-inline viewer (pdf — needs Blob) does NOT mount, falls back', async () => {
    await renderMessage('```viewer:pdf\nbinary content not appropriate for inline\n```');
    expect(container.querySelector('.message-inline-viewer')).toBeNull();
    expect(container.textContent).toContain('binary content');
  });

  test('regular language-tagged code blocks still render as CodeBlock (not as viewer)', async () => {
    await renderMessage('```js\nconsole.log("hello");\n```');
    expect(container.querySelector('.message-inline-viewer')).toBeNull();
    // Existing CodeBlock toolbar carries the language label.
    const toolbar = container.querySelector('.message-code-toolbar');
    expect(toolbar?.textContent).toContain('js');
  });
});
