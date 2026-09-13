// Smoke for SessionHistoryPanel — locks in:
//   1. Mount fires /api/sessions/:id/files with the right session id
//   2. The file list renders rows from the response
//   3. "恢复对话" calls onRestore with the original session record
//   4. Backdrop click / X button call onClose
//   5. No fetch when session is null

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { SessionHistoryPanel } from './session-history-panel.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN_KEY = 'codexmobile.deviceToken';

let calls;
let fetchSpy;
let container;
let root;

function makeFetch(responder) {
  return vi.fn(async (url) => {
    calls.push(String(url));
    const body = responder(String(url));
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(body),
      json: async () => body
    };
  });
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  calls = [];
  localStorage.setItem(TOKEN_KEY, 't');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('mount fetches /api/sessions/:id/files and renders the file list', async () => {
  fetchSpy = makeFetch(() => ({
    sessionId: 'abc1234',
    cwd: 'C:/repo',
    files: [
      { path: 'C:/repo/src/foo.js', op: 'update', touchedAt: 100 },
      { path: 'C:/repo/docs/new.md', op: 'add', touchedAt: 200 }
    ]
  }));
  vi.stubGlobal('fetch', fetchSpy);

  await act(async () => {
    root.render(
      <SessionHistoryPanel
        session={{ sessionId: 'abc1234', cwd: 'C:/repo', touchedAt: 1234 }}
        onClose={() => {}}
        onRestore={() => {}}
      />
    );
  });
  await flush();

  const url = calls.find((u) => u.includes('/api/sessions/abc1234/files'));
  expect(url).toBeDefined();
  expect(container.textContent).toContain('src/foo.js');
  expect(container.textContent).toContain('docs/new.md');
  expect(container.textContent).toContain('修改');
  expect(container.textContent).toContain('新增');
});

test('"恢复对话" button invokes onRestore with the original session record', async () => {
  fetchSpy = makeFetch(() => ({ sessionId: 'x', cwd: null, files: [] }));
  vi.stubGlobal('fetch', fetchSpy);

  const restored = [];
  const session = { sessionId: 'x', cwd: 'C:/repo', touchedAt: 1 };
  await act(async () => {
    root.render(
      <SessionHistoryPanel
        session={session}
        onClose={() => {}}
        onRestore={(s) => restored.push(s)}
      />
    );
  });
  await flush();

  const buttons = Array.from(container.querySelectorAll('button'));
  const restore = buttons.find((b) => b.textContent.includes('恢复对话'));
  expect(restore).toBeDefined();
  await act(async () => { restore.click(); });
  expect(restored).toEqual([session]);
});

test('clicking the backdrop fires onClose', async () => {
  fetchSpy = makeFetch(() => ({ sessionId: 'x', files: [] }));
  vi.stubGlobal('fetch', fetchSpy);
  let closed = 0;
  await act(async () => {
    root.render(
      <SessionHistoryPanel
        session={{ sessionId: 'x', cwd: '/r' }}
        onClose={() => { closed += 1; }}
      />
    );
  });
  await flush();
  const backdrop = container.querySelector('.session-history-backdrop');
  expect(backdrop).not.toBeNull();
  await act(async () => { backdrop.click(); });
  expect(closed).toBe(1);
});

test('clicking inside the panel does NOT propagate to backdrop', async () => {
  fetchSpy = makeFetch(() => ({ sessionId: 'x', files: [] }));
  vi.stubGlobal('fetch', fetchSpy);
  let closed = 0;
  await act(async () => {
    root.render(
      <SessionHistoryPanel
        session={{ sessionId: 'x' }}
        onClose={() => { closed += 1; }}
      />
    );
  });
  await flush();
  const panel = container.querySelector('.session-history-panel');
  await act(async () => { panel.click(); });
  expect(closed).toBe(0);
});

test('null session renders nothing and fires no fetch', async () => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  await act(async () => {
    root.render(<SessionHistoryPanel session={null} onClose={() => {}} />);
  });
  await flush();
  expect(container.querySelector('.session-history-panel')).toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('shows a plain-language empty message when files list is empty', async () => {
  fetchSpy = makeFetch(() => ({ sessionId: 'x', cwd: '/r', files: [] }));
  vi.stubGlobal('fetch', fetchSpy);
  await act(async () => {
    root.render(
      <SessionHistoryPanel
        session={{ sessionId: 'x', cwd: '/r' }}
        onClose={() => {}}
      />
    );
  });
  await flush();
  // No "apply_patch" / "Write" / "Edit" jargon leaks into the UI text.
  expect(container.textContent).toContain('没有改过文件');
  expect(container.textContent).not.toContain('apply_patch');
  expect(container.textContent).not.toContain('Write');
});
