// Smoke render of App.jsx + FilePreviewApp.jsx — verifies that the
// chat shell and the file-preview shell each mount without throwing on
// initial render. This is the safety net for hook-extraction refactors
// (Stage 2 R7 / R9 / R10+); a TDZ on a destructured hook return value
// or a stale identifier reference shows up here long before a real
// browser sees a white screen. Each test mocks fetch + WebSocket so
// the components never touch the network.

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// Tell React this is a real act() environment so the act() warnings
// emitted during effect commits are suppressed (vitest jsdom env does
// not flip this on automatically).
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class NoopWebSocket {
  constructor() {
    this.readyState = 0;
    this.send = () => {};
    this.close = () => {};
    this.addEventListener = () => {};
    this.removeEventListener = () => {};
  }
}

let container;
let root;
let captured;

function captureUnhandled() {
  const errors = [];
  const onError = (event) => {
    errors.push(event.error || event.reason || event.message);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onError);
  return { errors, dispose: () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onError);
  } };
}

beforeEach(() => {
  // Stub the network so bootstrap fetches resolve immediately with a
  // pairing-required response — App should render PairingScreen without
  // hitting any throwing code path.
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: false,
    status: 401,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ error: 'Pairing required' }),
    json: async () => ({ error: 'Pairing required' })
  })));
  vi.stubGlobal('WebSocket', NoopWebSocket);
  // matchMedia is consulted by pwa-theme.resolvePwaTheme — jsdom default
  // lacks it, so synthesize a stub that always reports "light".
  if (!window.matchMedia) {
    window.matchMedia = () => ({
      matches: false,
      media: '',
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false
    });
  }
  // pdfjs-dist references DOMMatrix at module-eval time. jsdom does not
  // provide it; stub the identity so PdfPreview's top-level imports do
  // not throw before our smoke renders even mount.
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
  container = document.createElement('div');
  container.id = 'root';
  document.body.appendChild(container);
  root = createRoot(container);
  captured = captureUnhandled();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  captured.dispose();
  vi.unstubAllGlobals();
  localStorage.clear();
});

// First mount of App.jsx through vitest pulls a large module graph (pdfjs,
// markdown, all panels) — first-time transform + import can sit right at
// the vitest default 5s timeout under parallel load. Give this single
// "cold mount" test extra headroom; the steady-state second test below
// uses the cached module and finishes in ~300ms.
test('App renders PairingScreen path without throwing (no token)', { timeout: 15000 }, async () => {
  localStorage.removeItem('codexmobile.deviceToken');
  const { default: App } = await import('./App.jsx');
  await act(async () => {
    root.render(<App />);
  });
  expect(captured.errors).toEqual([]);
  expect(container.textContent.length).toBeGreaterThan(0);
});

test('App renders without throwing when a stored token is present', async () => {
  // With a stored token App tries to fetch /api/status; the stubbed
  // fetch returns 401, which clears the token and falls back to
  // PairingScreen. Either branch must mount without throwing — that is
  // the only thing this smoke is here to enforce.
  localStorage.setItem('codexmobile.deviceToken', 'smoke-token');
  const { default: App } = await import('./App.jsx');
  await act(async () => {
    root.render(<App />);
  });
  expect(captured.errors).toEqual([]);
  expect(container.textContent.length).toBeGreaterThan(0);
});

test('FilePreviewApp renders without throwing for a path query', async () => {
  // Force the search string before importing FilePreviewApp — it reads
  // window.location.search synchronously via URLSearchParams during render.
  window.history.replaceState({}, '', '/preview/file?path=/tmp/smoke.md');
  const { default: FilePreviewApp } = await import('./app/FilePreviewApp.jsx');
  await act(async () => {
    root.render(<FilePreviewApp />);
  });
  expect(captured.errors).toEqual([]);
});
