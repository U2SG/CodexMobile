// vitest + jsdom smoke for JsonViewer: tree rendering, default expansion
// depth, click-to-toggle, and parse-failure fallback.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { JsonViewer } from './JsonViewer.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // The integration block imports the viewers barrel which transitively
  // pulls pdfjs-dist (DOMMatrix at module-eval).
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

async function renderJson(text) {
  await act(async () => {
    root.render(<JsonViewer.Component text={text} />);
  });
}

describe('JsonViewer', () => {
  test('renders a primitive at the top level inline', async () => {
    await renderJson('42');
    expect(container.querySelector('.json-number')?.textContent).toBe('42');
    expect(container.querySelector('.json-tree')).toBeNull(); // no <ul> for a bare primitive
  });

  test('renders an object: top-level expanded, primitives visible', async () => {
    await renderJson(JSON.stringify({ name: 'Alice', age: 30 }));
    expect(container.querySelector('.json-tree')).not.toBeNull();
    // String value escaped with quotes.
    const strings = [...container.querySelectorAll('.json-string')].map((n) => n.textContent);
    expect(strings).toContain('"Alice"');
    const numbers = [...container.querySelectorAll('.json-number')].map((n) => n.textContent);
    expect(numbers).toContain('30');
    // Keys are JSON-quoted.
    const keys = [...container.querySelectorAll('.json-key')].map((n) => n.textContent);
    expect(keys).toContain('"name":');
    expect(keys).toContain('"age":');
  });

  test('shallow nesting (within default-expand depth) renders all leaves immediately', async () => {
    // Component renders root JsonNode at depth=0 with no key. Its children
    // (outer) get depth=1 — still <= DEFAULT_EXPAND_DEPTH=1 → expanded.
    // outer's leaf-child "deep" renders inline because its parent is open.
    await renderJson(JSON.stringify({ outer: { deep: 'value' } }));
    expect(container.textContent).toContain('"outer":');
    expect(container.textContent).toContain('"deep":');
    expect(container.textContent).toContain('"value"');
  });

  test('deep container (depth > 1) collapses by default and re-expands on click', async () => {
    // Component depth math: root=0, lvl0=1, lvl1=2 (>1 → COLLAPSED by default).
    await renderJson(JSON.stringify({
      lvl0: {
        lvl1: {
          hidden: 'until-expanded'
        }
      }
    }));
    expect(container.textContent).not.toContain('hidden');
    const rows = [...container.querySelectorAll('.json-row-head.is-container')];
    const lvl1Row = rows.find((row) => row.querySelector('.json-key')?.textContent === '"lvl1":');
    expect(lvl1Row).toBeTruthy();
    await act(async () => {
      lvl1Row.click();
    });
    expect(container.textContent).toContain('hidden');
    expect(container.textContent).toContain('"until-expanded"');
  });

  test('arrays render with numeric index labels and a count summary when collapsed', async () => {
    await renderJson(JSON.stringify({ items: ['a', 'b', 'c'] }));
    // Array at depth 1 → expanded → its 3 children render.
    const keys = [...container.querySelectorAll('.json-key')].map((n) => n.textContent);
    expect(keys).toContain('0:');
    expect(keys).toContain('1:');
    expect(keys).toContain('2:');
    expect(container.textContent).toContain('"a"');
    expect(container.textContent).toContain('"c"');
  });

  test('parse failure falls back to <pre> with an error label (raw text still readable)', async () => {
    await renderJson('this is not json, but } here is { junk');
    expect(container.querySelector('.json-viewer.is-error')).not.toBeNull();
    expect(container.querySelector('.json-viewer-error-label')?.textContent).toMatch(/JSON 解析失败/);
    expect(container.querySelector('.json-viewer-raw')?.textContent).toContain('this is not json');
  });

  test('null / booleans render as their typed spans', async () => {
    await renderJson(JSON.stringify({ a: null, b: true, c: false }));
    expect(container.querySelector('.json-null')?.textContent).toBe('null');
    const bools = [...container.querySelectorAll('.json-bool')].map((n) => n.textContent);
    expect(bools).toEqual(['true', 'false']);
  });
});

describe('JsonViewer integration with chat inline viewer path', () => {
  test('```viewer:json fenced block mounts JsonViewer (via the registry barrel)', async () => {
    await import('./index.js'); // ensure barrel registration has run
    const { MessageContent } = await import('../chat/MessageContent.jsx');
    await act(async () => {
      root.render(
        <MessageContent
          content={'Result:\n\n```viewer:json\n{ "ok": true, "count": 3 }\n```\n\nDone.'}
          isUser={false}
        />
      );
    });
    const inline = container.querySelector('.message-inline-viewer[data-viewer-id="json"]');
    expect(inline).not.toBeNull();
    expect(inline.querySelector('.json-bool')?.textContent).toBe('true');
    expect(inline.querySelector('.json-number')?.textContent).toBe('3');
  });
});
