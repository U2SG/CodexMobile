// Smoke for the visibility/online refresh path added so PWAs don't have
// to wait for the 30s useDesktopBridge poll to see desktop bridge state
// changes (e.g. user backgrounds the tab while desktop restarts, then
// comes back — should pull fresh status immediately).

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN_KEY = 'codexmobile.deviceToken';
let calls;
let container;
let root;

function HookHost() {
  const { useDesktopBridge } = require('./useDesktopBridge.js');
  useDesktopBridge({ authenticated: true });
  return null;
}

beforeEach(() => {
  calls = [];
  localStorage.setItem(TOKEN_KEY, 'smoke-token');
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ connected: true, openThreadIds: [] }),
      json: async () => ({ connected: true, openThreadIds: [] })
    };
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('mounting useDesktopBridge fetches /api/desktop/status once', async () => {
  await act(async () => {
    root.render(<HookHost />);
  });
  const desktopHits = calls.filter((u) => u.includes('/api/desktop/status'));
  expect(desktopHits.length).toBe(1);
});

test('visibilitychange→visible triggers a forced /api/desktop/status refresh', async () => {
  await act(async () => {
    root.render(<HookHost />);
  });
  const before = calls.filter((u) => u.includes('/api/desktop/status')).length;

  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible'
  });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });

  const after = calls.filter((u) => u.includes('/api/desktop/status')).length;
  expect(after).toBeGreaterThan(before);
  // force=1 query so the cache TTL is bypassed
  const lastHit = calls.filter((u) => u.includes('/api/desktop/status')).at(-1);
  expect(lastHit).toContain('force=1');
});

test('window online event triggers a forced refresh', async () => {
  await act(async () => {
    root.render(<HookHost />);
  });
  const before = calls.filter((u) => u.includes('/api/desktop/status')).length;

  await act(async () => {
    window.dispatchEvent(new Event('online'));
  });

  const after = calls.filter((u) => u.includes('/api/desktop/status')).length;
  expect(after).toBeGreaterThan(before);
});
