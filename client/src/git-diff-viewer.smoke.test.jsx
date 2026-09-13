// Smoke for GitDiffViewer — locks in:
//   1. Breadcrumb splits the path into clickable segments + chevrons
//   2. onPathClick fires with the prefix path (not just the segment)
//   3. Each diff line is wrapped in a span carrying data-line-index
//   4. onSelectionChange fires with {file, commit, startLine, endLine, text}
//      when the user selects across multiple lines inside the body
//   5. commit + staged tags render when given

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { GitDiffViewer } from './git-diff-viewer.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;

const SAMPLE_DIFF = [
  'diff --git a/src/foo.js b/src/foo.js',
  'index abc..def 100644',
  '--- a/src/foo.js',
  '+++ b/src/foo.js',
  '@@ -1,3 +1,3 @@',
  ' unchanged',
  '-removed line',
  '+added line'
].join('\n');

beforeEach(() => {
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
});

test('breadcrumb renders each path segment as a button with the last one as is-last', async () => {
  await act(async () => {
    root.render(<GitDiffViewer diff={SAMPLE_DIFF} file="src/components/Foo.jsx" />);
  });
  const segments = Array.from(container.querySelectorAll('.git-diff-breadcrumb-segment'));
  expect(segments.map((b) => b.textContent)).toEqual(['src', 'components', 'Foo.jsx']);
  expect(segments[segments.length - 1].classList.contains('is-last')).toBe(true);
});

test('onPathClick receives the full prefix path, not just the leaf segment', async () => {
  const observed = [];
  await act(async () => {
    root.render(
      <GitDiffViewer
        diff={SAMPLE_DIFF}
        file="src/components/Foo.jsx"
        onPathClick={(p) => observed.push(p)}
      />
    );
  });
  const segments = container.querySelectorAll('.git-diff-breadcrumb-segment');
  await act(async () => { segments[1].click(); });
  expect(observed).toEqual(['src/components']);
});

test('Windows backslash paths get normalized in the breadcrumb', async () => {
  await act(async () => {
    root.render(<GitDiffViewer diff="" file="src\\components\\Foo.jsx" />);
  });
  const segments = Array.from(container.querySelectorAll('.git-diff-breadcrumb-segment'));
  expect(segments.map((b) => b.textContent)).toEqual(['src', 'components', 'Foo.jsx']);
});

test('each diff line is wrapped in a span carrying data-line-index', async () => {
  await act(async () => {
    root.render(<GitDiffViewer diff={SAMPLE_DIFF} file="src/foo.js" />);
  });
  const lineSpans = Array.from(container.querySelectorAll('.diff-line[data-line-index]'));
  expect(lineSpans.length).toBe(SAMPLE_DIFF.split('\n').length);
  expect(lineSpans[0].dataset.lineIndex).toBe('0');
});

test('staged + commit tags render with short hash', async () => {
  await act(async () => {
    root.render(
      <GitDiffViewer diff={SAMPLE_DIFF} file="x" staged={1} commit="abcdef0123456789" />
    );
  });
  const tags = Array.from(container.querySelectorAll('.staged-tag'));
  expect(tags.map((t) => t.textContent)).toEqual(['已暂存', '@ abcdef0']);
});

// NOTE: jsdom's Selection does not honor programmatic `sel.addRange(range)` —
// isCollapsed stays true and rangeCount returns 0, so the production handler
// bails before reaching findLineIndex. The next test stubs window.getSelection
// to hand the hook a Selection-shaped object with real DOM nodes. This
// verifies the handler's routing logic (DOM walking, line-index extraction,
// callback payload shape) but NOT the browser-native selectionchange path.
// Real-browser behavior is exercised manually in iPhone Safari + desktop
// Chrome before shipping.
test('selectionchange fires onSelectionChange with start/end lines and text', async () => {
  const events = [];
  await act(async () => {
    root.render(
      <GitDiffViewer
        diff={SAMPLE_DIFF}
        file="src/foo.js"
        commit="abcdef0"
        onSelectionChange={(s) => events.push(s)}
      />
    );
  });

  const body = container.querySelector('.git-diff-body');
  const lines = body.querySelectorAll('.diff-line[data-line-index]');
  // Stub window.getSelection — jsdom's real Selection doesn't carry isCollapsed=false
  // after programmatic addRange, so we hand the hook the shape it expects:
  // anchorNode/focusNode set to two line spans, rangeCount=1, isCollapsed=false,
  // toString() returns the joined line text.
  const startLine = lines[5];
  const endLine = lines[7];
  const fakeRange = {
    startContainer: startLine,
    endContainer: endLine
  };
  const text = `${startLine.textContent}\n${lines[6].textContent}\n${endLine.textContent}`;
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => fakeRange,
    toString: () => text
  });

  await act(async () => {
    document.dispatchEvent(new Event('selectionchange'));
  });

  expect(events.length).toBeGreaterThan(0);
  const last = events[events.length - 1];
  expect(last.file).toBe('src/foo.js');
  expect(last.commit).toBe('abcdef0');
  expect(last.startLine).toBe(6);
  expect(last.endLine).toBe(8);
  expect(last.text.length).toBeGreaterThan(0);
});

test('renders "近期改过" badges when /api/files/sessions returns sessions', async () => {
  const fetchSpy = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({
      sessions: [
        { sessionId: 'abc1234567', op: 'update', touchedAt: 1234 },
        { sessionId: 'def0000000', op: 'add', touchedAt: 1235 }
      ]
    }),
    json: async () => ({
      sessions: [
        { sessionId: 'abc1234567', op: 'update', touchedAt: 1234 },
        { sessionId: 'def0000000', op: 'add', touchedAt: 1235 }
      ]
    })
  }));
  vi.stubGlobal('fetch', fetchSpy);
  localStorage.setItem('codexmobile.deviceToken', 't');

  await act(async () => {
    root.render(
      <GitDiffViewer
        diff={SAMPLE_DIFF}
        file="src/foo.js"
        projectId="p1"
        onSelectSession={() => {}}
      />
    );
  });
  // Let the apiFetch promise settle.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  const badges = Array.from(container.querySelectorAll('.git-diff-related-badge'));
  expect(badges.length).toBe(2);
  expect(badges[0].textContent).toContain('abc12345');
  expect(fetchSpy).toHaveBeenCalled();
  const calledUrl = String(fetchSpy.mock.calls[0][0]);
  expect(calledUrl).toContain('/api/files/sessions');
  expect(calledUrl).toContain('projectId=p1');
  expect(calledUrl).toContain('path=src%2Ffoo.js');
});

test('badge click invokes onSelectSession with the full session record', async () => {
  const fetchSpy = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({
      sessions: [{ sessionId: 'click-me-1234', op: 'update', touchedAt: 1, cwd: 'C:/other-repo' }]
    }),
    json: async () => ({
      sessions: [{ sessionId: 'click-me-1234', op: 'update', touchedAt: 1, cwd: 'C:/other-repo' }]
    })
  }));
  vi.stubGlobal('fetch', fetchSpy);
  localStorage.setItem('codexmobile.deviceToken', 't');

  const observed = [];
  await act(async () => {
    root.render(
      <GitDiffViewer
        diff={SAMPLE_DIFF}
        file="src/foo.js"
        projectId="p1"
        onSelectSession={(record) => observed.push(record)}
      />
    );
  });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  const badge = container.querySelector('.git-diff-related-badge');
  expect(badge).not.toBeNull();
  await act(async () => { badge.click(); });
  expect(observed).toHaveLength(1);
  expect(observed[0].sessionId).toBe('click-me-1234');
  // cwd must come through so the caller can map foreign-project sessions
  // to the correct project context instead of inheriting the current one.
  expect(observed[0].cwd).toBe('C:/other-repo');
});

test('foreign-agent badge with matching peer renders as anchor to peer URL', async () => {
  const fetchSpy = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({
      sessions: [
        { sessionId: 'foreign-abc', op: 'update', touchedAt: 1, cwd: '/r', agent: 'claude' }
      ]
    }),
    json: async () => ({
      sessions: [
        { sessionId: 'foreign-abc', op: 'update', touchedAt: 1, cwd: '/r', agent: 'claude' }
      ]
    })
  }));
  vi.stubGlobal('fetch', fetchSpy);
  localStorage.setItem('codexmobile.deviceToken', 't');

  await act(async () => {
    root.render(
      <GitDiffViewer
        diff={SAMPLE_DIFF}
        file="src/foo.js"
        projectId="p1"
        currentAgent="codex"
        peers={[{ url: 'https://claude.peer.example', label: 'Claude', agent: 'claude' }]}
        onSelectSession={() => {}}
      />
    );
  });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  const anchor = container.querySelector('a.git-diff-related-badge.is-peer-link');
  expect(anchor).not.toBeNull();
  expect(anchor.getAttribute('href')).toBe('https://claude.peer.example/?session=foreign-abc');
});

test('foreign-agent badge with no matching peer renders disabled with hint', async () => {
  const fetchSpy = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({
      sessions: [{ sessionId: 'lonely-foreign', op: 'update', touchedAt: 1, cwd: '/r', agent: 'claude' }]
    }),
    json: async () => ({
      sessions: [{ sessionId: 'lonely-foreign', op: 'update', touchedAt: 1, cwd: '/r', agent: 'claude' }]
    })
  }));
  vi.stubGlobal('fetch', fetchSpy);
  localStorage.setItem('codexmobile.deviceToken', 't');

  await act(async () => {
    root.render(
      <GitDiffViewer
        diff={SAMPLE_DIFF}
        file="src/foo.js"
        projectId="p1"
        currentAgent="codex"
        peers={[]}
        onSelectSession={() => {}}
      />
    );
  });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  const button = container.querySelector('.git-diff-related-badge.is-foreign-disabled');
  expect(button).not.toBeNull();
  expect(button.disabled).toBe(true);
  // The hint should mention configuring CODEXMOBILE_PEER_URLS.
  expect(button.getAttribute('title')).toContain('CODEXMOBILE_PEER_URLS');
});

test('no badges render when projectId is missing (no fetch attempted)', async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  await act(async () => {
    root.render(<GitDiffViewer diff={SAMPLE_DIFF} file="src/foo.js" />);
  });
  await act(async () => { await Promise.resolve(); });
  expect(container.querySelector('.git-diff-related-sessions')).toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('selectionchange outside the diff body is ignored', async () => {
  const events = [];
  await act(async () => {
    root.render(
      <div>
        <GitDiffViewer
          diff={SAMPLE_DIFF}
          file="src/foo.js"
          onSelectionChange={(s) => events.push(s)}
        />
        <p data-outside="1">outside</p>
      </div>
    );
  });

  const outside = container.querySelector('[data-outside]');
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => ({ startContainer: outside, endContainer: outside }),
    toString: () => 'outside'
  });

  await act(async () => {
    document.dispatchEvent(new Event('selectionchange'));
  });

  expect(events).toEqual([]);
});
