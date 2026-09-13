// vitest + jsdom smoke for the shipped viewer barrel — the JSX viewers
// can't be loaded under node:test, so the path-routing + ordering
// assertions live here. Pure registry primitives are in
// viewer-registry.test.mjs.

import { beforeAll, describe, expect, test } from 'vitest';

beforeAll(() => {
  // pdfjs-dist references DOMMatrix at module-eval (via PdfViewer → PdfPreview);
  // jsdom doesn't provide it. Mirror the stub from App.smoke.test.jsx so
  // importing the barrel doesn't throw.
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

describe('shipped viewer registry', () => {
  test('registers markdown → image → pdf → json → text → download in that order', async () => {
    const barrel = await import('./index.js');
    const { listViewers, _resetForTest } = await import('./viewer-registry.js');
    void barrel;
    const ids = listViewers().map((viewer) => viewer.id);
    expect(ids).toEqual(['markdown', 'image', 'pdf', 'json', 'text', 'download']);
    // Don't reset here — other tests in this file share the registration.
    void _resetForTest;
  });

  test('routes paths to the right viewer id', async () => {
    await import('./index.js');
    const { resolveViewer } = await import('./viewer-registry.js');
    expect(resolveViewer({ path: '/x.md' })?.id).toBe('markdown');
    expect(resolveViewer({ path: '/x.MD' })?.id).toBe('markdown');
    expect(resolveViewer({ path: '/x.png' })?.id).toBe('image');
    expect(resolveViewer({ path: '/x.jpg' })?.id).toBe('image');
    expect(resolveViewer({ path: '/x.pdf' })?.id).toBe('pdf');
    expect(resolveViewer({ path: '/x.txt' })?.id).toBe('text');
    expect(resolveViewer({ path: '/x.json' })?.id).toBe('json');
    expect(resolveViewer({ path: '/x.bin' })?.id).toBe('download');
  });

  test('routes by content-type when path lacks an extension', async () => {
    await import('./index.js');
    const { resolveViewer } = await import('./viewer-registry.js');
    expect(resolveViewer({ path: '/no-ext', contentType: 'image/png' })?.id).toBe('image');
    expect(resolveViewer({ path: '/no-ext', contentType: 'application/pdf' })?.id).toBe('pdf');
    expect(resolveViewer({ path: '/no-ext', contentType: 'text/plain' })?.id).toBe('text');
    expect(resolveViewer({ path: '/no-ext', contentType: 'text/markdown; charset=utf-8' })?.id).toBe('markdown');
    expect(resolveViewer({ path: '/no-ext', contentType: 'application/json' })?.id).toBe('json');
  });

  test('json beats text on .json even though TextViewer accepts .json as backstop', async () => {
    await import('./index.js');
    const { resolveViewer } = await import('./viewer-registry.js');
    expect(resolveViewer({ path: '/config.json' })?.id).toBe('json');
  });

  test('markdown beats text on .md even though TextViewer accepts text extensions', async () => {
    await import('./index.js');
    const { resolveViewer } = await import('./viewer-registry.js');
    expect(resolveViewer({ path: '/notes.md' })?.id).toBe('markdown');
  });
});
