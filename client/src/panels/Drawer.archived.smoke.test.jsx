// vitest + jsdom smoke that reproduces the "已归档 list is cut in half
// by the 工具与服务 section" rendering bug. We mount Drawer with 16
// archived projects expanded and walk the actual DOM to see what
// section each archived row lands inside — the bug shows up as
// archived rows being children of `.drawer-controls` instead of all
// being children of `.archived-project-list`.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;

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
  if (!window.matchMedia) {
    window.matchMedia = () => ({
      matches: false, media: '', addEventListener: () => {}, removeEventListener: () => {}, onchange: null
    });
  }
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  // Stub the /api/projects/archived fetch with 16 items so the archived
  // section is "large" enough to expose any layout containment issue.
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/api/projects/archived')) {
      const projects = Array.from({ length: 16 }, (_, i) => ({
        id: `proj-${i}`,
        name: `archived-project-${i}`,
        path: `/path/to/archived-project-${i}`
      }));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ projects }),
        text: async () => JSON.stringify({ projects })
      };
    }
    return {
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({}),
      text: async () => '{}'
    };
  }));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('Drawer archived list — layout containment', () => {
  test('all 16 archived rows live inside .archived-project-list, not bleeding into .drawer-controls', async () => {
    const { Drawer } = await import('./Drawer.jsx');
    const baseProps = {
      open: true,
      onClose: () => {},
      projects: [],
      pinFolders: [],
      pinnedSessions: [],
      selectedProject: null,
      selectedSession: null,
      expandedProjectIds: {},
      sessionsByProject: {},
      loadingProjectId: null,
      onToggleProject: () => {},
      onSelectSession: () => {},
      onRenameSession: () => {},
      onDeleteSession: () => {},
      onArchiveProject: () => {},
      onRestoreProject: () => {},
      onTogglePin: () => {},
      onMoveSessionToFolder: () => {},
      onCreatePinFolder: () => {},
      onRenamePinFolder: () => {},
      onDeletePinFolder: () => {},
      onToggleFolderCollapsed: () => {},
      onNewConversation: () => {},
      onSync: () => {},
      onOpenGit: () => {},
      onOpenNotifications: () => {},
      onOpenActivity: () => {},
      peers: [],
      syncing: false,
      theme: 'light',
      setTheme: () => {},
      status: { provider: 'claude' },
      desktopBridge: { openThreadIds: [] },
      runtimePrefs: {},
      onSetRuntimePref: () => {}
    };

    // Pre-flip the "archived expanded" localStorage so the useState
    // initialiser opens it on mount. The component currently doesn't
    // hydrate this from storage — but we can click the heading instead.
    await act(async () => {
      root.render(<Drawer {...baseProps} />);
    });

    // Click the "已归档" heading toggle to expand the section, which
    // triggers the fetch effect we stubbed.
    const archivedSection = container.querySelector('.archived-project-section');
    expect(archivedSection).not.toBeNull();
    const headingToggle = archivedSection.querySelector('.drawer-heading-toggle');
    expect(headingToggle).not.toBeNull();
    await act(async () => { headingToggle.click(); });
    // Allow the fetch micro-tasks + setState to settle.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    const archivedList = container.querySelector('.archived-project-list');
    expect(archivedList, 'archived list should be rendered after expand').not.toBeNull();
    const rowsInList = archivedList.querySelectorAll('.archived-project-row');
    expect(rowsInList.length).toBe(16);

    // None of the archived rows should be children of drawer-controls.
    const controls = container.querySelector('.drawer-controls');
    expect(controls).not.toBeNull();
    const rowsInControls = controls.querySelectorAll('.archived-project-row');
    expect(rowsInControls.length).toBe(0);

    // Sanity: the .archived-project-section <section> precedes the
    // .drawer-controls <section> in document order. If the bug were a
    // JSX duplication, drawer-controls would be sandwiched between
    // two archived-project-list nodes.
    const sections = [...container.querySelectorAll('section')];
    const archivedIndex = sections.findIndex((s) => s.classList.contains('archived-project-section'));
    const controlsIndex = sections.findIndex((s) => s.classList.contains('drawer-controls'));
    expect(archivedIndex).toBeGreaterThanOrEqual(0);
    expect(controlsIndex).toBeGreaterThanOrEqual(0);
    expect(controlsIndex).toBeGreaterThan(archivedIndex);
    // And there is exactly one of each.
    expect(sections.filter((s) => s.classList.contains('archived-project-section')).length).toBe(1);
    expect(sections.filter((s) => s.classList.contains('drawer-controls')).length).toBe(1);
  });

  test('archived list has containment classes that prevent flex-overflow under drawer-controls', async () => {
    // This is the regression net for the "Git/tools panel visually
    // covers items 7-? of the archived list" bug — it happened because
    // .drawer-section sets min-height: 0 (so flex parents can shrink it
    // below content size), .archived-project-list had no max-height, and
    // .drawer-controls had a solid background that painted over the
    // overflow. Two CSS fixes guard against regression:
    //   - .archived-project-list { max-height; overflow-y: auto }
    //   - .archived-project-section { overflow: hidden }
    // We can't validate computed styles meaningfully under jsdom (no
    // layout engine), but we CAN assert the wrapping element exists and
    // is reachable so the CSS selector has a hook.
    const { Drawer } = await import('./Drawer.jsx');
    const baseProps = {
      open: true, onClose: () => {}, projects: [], pinFolders: [], pinnedSessions: [],
      selectedProject: null, selectedSession: null, expandedProjectIds: {}, sessionsByProject: {},
      loadingProjectId: null,
      onToggleProject: () => {}, onSelectSession: () => {}, onRenameSession: () => {},
      onDeleteSession: () => {}, onArchiveProject: () => {}, onRestoreProject: () => {},
      onTogglePin: () => {}, onMoveSessionToFolder: () => {}, onCreatePinFolder: () => {},
      onRenamePinFolder: () => {}, onDeletePinFolder: () => {}, onToggleFolderCollapsed: () => {},
      onNewConversation: () => {}, onSync: () => {}, onOpenGit: () => {},
      onOpenNotifications: () => {}, onOpenActivity: () => {},
      peers: [], syncing: false, theme: 'light', setTheme: () => {},
      status: { provider: 'claude' }, desktopBridge: { openThreadIds: [] },
      runtimePrefs: {}, onSetRuntimePref: () => {}
    };

    await act(async () => { root.render(<Drawer {...baseProps} />); });
    const headingToggle = container.querySelector('.archived-project-section .drawer-heading-toggle');
    await act(async () => { headingToggle.click(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    const section = container.querySelector('.archived-project-section');
    const list = container.querySelector('.archived-project-list');
    expect(section).not.toBeNull();
    expect(list).not.toBeNull();
    // With 16 items > 6, the is-short modifier must NOT be set so the
    // mask-image fade hint is active.
    expect(section.classList.contains('is-short')).toBe(false);
  });
});
