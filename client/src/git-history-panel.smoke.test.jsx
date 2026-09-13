// Smoke for GitHistoryPanel — verifies the three load paths exercise the
// expected endpoints (/api/git/history then /api/git/commit-files/:hash on
// expand) and that onSelectCommitFile is invoked when a file row is clicked.

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { GitHistoryPanel } from './git-history-panel.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN_KEY = 'codexmobile.deviceToken';

let fetchSpy;
let calls;
let container;
let root;

function makeFetch(responder) {
  return vi.fn(async (url, options) => {
    calls.push({ url: String(url), method: options?.method || 'GET' });
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
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  calls = [];
  localStorage.setItem(TOKEN_KEY, 'smoke-token');
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

test('on mount, GitHistoryPanel fetches /api/git/history with projectId + includeFiles=1', async () => {
  fetchSpy = makeFetch(() => ({
    commits: [
      { hash: 'aaaaaaaaa', parents: [], author: 'Alice', date: '2026-05-01T10:00:00Z', subject: 'first', body: '' }
    ],
    nextCursor: null
  }));
  vi.stubGlobal('fetch', fetchSpy);

  await act(async () => {
    root.render(<GitHistoryPanel project={{ id: 'p1' }} />);
  });
  await flush();

  const historyCall = calls.find((c) => c.url.includes('/api/git/history'));
  expect(historyCall).toBeDefined();
  expect(historyCall.url).toContain('projectId=p1');
  // Batched-files mode is the default — no per-commit-files roundtrips on expand.
  expect(historyCall.url).toContain('includeFiles=1');
  expect(container.textContent).toContain('first');
});

test('when history returns inline files, expanding a commit does NOT hit /api/git/commit-files', async () => {
  fetchSpy = makeFetch((url) => {
    if (url.includes('/api/git/history')) {
      return {
        commits: [
          {
            hash: 'abc1234',
            parents: [],
            author: 'A',
            date: '2026-05-01T10:00:00Z',
            subject: 'msg',
            body: '',
            files: [{ status: 'M', path: 'src/inline.js' }]
          }
        ],
        nextCursor: null
      };
    }
    return {};
  });
  vi.stubGlobal('fetch', fetchSpy);

  await act(async () => {
    root.render(<GitHistoryPanel project={{ id: 'p1' }} />);
  });
  await flush();

  const commitButton = container.querySelector('.git-timeline-commit');
  await act(async () => { commitButton.click(); });
  await flush();

  // No fallback fetch — inline files served the expand.
  expect(calls.filter((c) => c.url.includes('/api/git/commit-files/')).length).toBe(0);
  expect(container.textContent).toContain('src/inline.js');
});

test('clicking a commit expands and fetches /api/git/commit-files/:hash', async () => {
  fetchSpy = makeFetch((url) => {
    if (url.includes('/api/git/history')) {
      return {
        commits: [
          { hash: 'abc1234', parents: [], author: 'A', date: '2026-05-01T10:00:00Z', subject: 'msg', body: '' }
        ],
        nextCursor: null
      };
    }
    if (url.includes('/api/git/commit-files/')) {
      return { hash: 'abc1234', files: [{ status: 'M', path: 'src/foo.js' }] };
    }
    return {};
  });
  vi.stubGlobal('fetch', fetchSpy);

  await act(async () => {
    root.render(<GitHistoryPanel project={{ id: 'p1' }} />);
  });
  await flush();

  const commitButton = container.querySelector('.git-timeline-commit');
  expect(commitButton).not.toBeNull();
  await act(async () => {
    commitButton.click();
  });
  await flush();

  const filesCall = calls.find((c) => c.url.includes('/api/git/commit-files/abc1234'));
  expect(filesCall).toBeDefined();
  expect(container.textContent).toContain('src/foo.js');
});

test('clicking a file row invokes onSelectCommitFile with commit + file', async () => {
  const selections = [];
  fetchSpy = makeFetch((url) => {
    if (url.includes('/api/git/history')) {
      return {
        commits: [
          { hash: 'abc1234', parents: [], author: 'A', date: '2026-05-01T10:00:00Z', subject: 'msg', body: '' }
        ],
        nextCursor: null
      };
    }
    return { hash: 'abc1234', files: [{ status: 'M', path: 'src/foo.js' }] };
  });
  vi.stubGlobal('fetch', fetchSpy);

  await act(async () => {
    root.render(
      <GitHistoryPanel
        project={{ id: 'p1' }}
        onSelectCommitFile={(commit, file) => selections.push({ commit, file })}
      />
    );
  });
  await flush();
  const commitButton = container.querySelector('.git-timeline-commit');
  await act(async () => { commitButton.click(); });
  await flush();
  const fileButton = container.querySelector('.git-commit-file-list .file-row');
  expect(fileButton).not.toBeNull();
  await act(async () => { fileButton.click(); });

  expect(selections).toHaveLength(1);
  expect(selections[0].commit.hash).toBe('abc1234');
  expect(selections[0].file.path).toBe('src/foo.js');
});

test('IntersectionObserver auto-loads next page when sentinel becomes visible', async () => {
  // Capture the observer callback so we can fire it manually — jsdom has
  // no real intersection logic, only the API shape.
  let capturedCallback = null;
  let observeCount = 0;
  let disconnectCount = 0;
  class FakeIO {
    constructor(cb) { capturedCallback = cb; }
    observe() { observeCount += 1; }
    disconnect() { disconnectCount += 1; }
    unobserve() {}
  }
  vi.stubGlobal('IntersectionObserver', FakeIO);

  fetchSpy = makeFetch((url) => {
    if (url.includes('/api/git/history') && url.includes('cursor=cursor1')) {
      return {
        commits: [{ hash: 'page2', parents: [], author: 'A', date: '2026-04-30T10:00:00Z', subject: 'older', body: '' }],
        nextCursor: null
      };
    }
    return {
      commits: [{ hash: 'page1', parents: [], author: 'A', date: '2026-05-01T10:00:00Z', subject: 'newer', body: '' }],
      nextCursor: 'cursor1'
    };
  });
  vi.stubGlobal('fetch', fetchSpy);

  await act(async () => {
    root.render(<GitHistoryPanel project={{ id: 'p1' }} />);
  });
  await flush();

  // Sentinel + button both present while hasMore is true.
  expect(container.querySelector('.git-load-sentinel')).not.toBeNull();
  expect(container.querySelector('.git-load-more')).not.toBeNull();
  expect(observeCount).toBeGreaterThan(0);
  expect(capturedCallback).toBeTypeOf('function');

  // Fire intersection — should auto-load page 2.
  await act(async () => {
    capturedCallback([{ isIntersecting: true }]);
  });
  await flush();

  expect(container.textContent).toContain('older');
  // After page 2 lands and nextCursor goes null, both sentinel and button
  // disappear and the observer is disconnected.
  expect(container.querySelector('.git-load-sentinel')).toBeNull();
  expect(disconnectCount).toBeGreaterThan(0);
});

test('after a failed load, the observer is not re-attached until error clears', async () => {
  let constructedCount = 0;
  let disconnectCount = 0;
  let lastCallback = null;
  class FakeIO {
    constructor(cb) {
      constructedCount += 1;
      lastCallback = cb;
    }
    observe() {}
    disconnect() { disconnectCount += 1; }
    unobserve() {}
  }
  vi.stubGlobal('IntersectionObserver', FakeIO);

  fetchSpy = vi.fn(async (url) => {
    calls.push({ url: String(url), method: 'GET' });
    if (String(url).includes('cursor=cursor1')) {
      return {
        ok: false,
        status: 500,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ error: 'boom' }),
        json: async () => ({ error: 'boom' })
      };
    }
    const body = {
      commits: [{ hash: 'p1', parents: [], author: 'A', date: 'd', subject: 's', body: '' }],
      nextCursor: 'cursor1'
    };
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(body),
      json: async () => body
    };
  });
  vi.stubGlobal('fetch', fetchSpy);

  await act(async () => {
    root.render(<GitHistoryPanel project={{ id: 'p1' }} />);
  });
  await flush();
  // Page 1 lands: hasMore went true → effect attaches one observer.
  expect(constructedCount).toBe(1);
  const observersBeforeFailure = constructedCount;

  // Trigger page-2 load by firing intersection → fetch fails → error state.
  await act(async () => {
    lastCallback?.([{ isIntersecting: true }]);
  });
  await flush();

  expect(calls.filter((c) => c.url.includes('/api/git/history')).length).toBe(2);
  // The effect's cleanup ran when loadingMore flipped (disconnect counted).
  // After error is set, the effect runs again but bails on the !error
  // guard — NO new observer is constructed. Without the guard, observers
  // would be re-attached after every render and the sentinel-in-viewport
  // scenario would loop forever.
  expect(constructedCount).toBe(observersBeforeFailure);
  expect(disconnectCount).toBeGreaterThan(0);
});

test('shows "加载更多" only when nextCursor is set, and uses it on next page', async () => {
  fetchSpy = makeFetch((url) => {
    if (url.includes('/api/git/history') && url.includes('cursor=cursor1')) {
      return {
        commits: [
          { hash: 'page2-a', parents: [], author: 'A', date: '2026-04-30T10:00:00Z', subject: 'older', body: '' }
        ],
        nextCursor: null
      };
    }
    return {
      commits: [
        { hash: 'page1-a', parents: [], author: 'A', date: '2026-05-01T10:00:00Z', subject: 'newer', body: '' }
      ],
      nextCursor: 'cursor1'
    };
  });
  vi.stubGlobal('fetch', fetchSpy);

  await act(async () => {
    root.render(<GitHistoryPanel project={{ id: 'p1' }} />);
  });
  await flush();
  // Page 1 rendered + button visible
  expect(container.textContent).toContain('newer');
  const loadMore = container.querySelector('.git-load-more button');
  expect(loadMore).not.toBeNull();

  await act(async () => { loadMore.click(); });
  await flush();

  // Page 2 appended; older commit visible too
  expect(container.textContent).toContain('newer');
  expect(container.textContent).toContain('older');
  // Button gone now
  expect(container.querySelector('.git-load-more')).toBeNull();
});
