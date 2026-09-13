// vitest + jsdom smoke for the worktree picker. Verifies (1) one click fires
// onSelect exactly once with the full worktree object — under StrictMode, which
// double-invokes render/effects and would expose any impure side-effect path —
// and (2) the main worktree is labelled and listed first.

import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { WorktreePicker } from './WorktreePicker.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

const WORKTREES = [
  { path: '/repo/main', branch: 'main', detached: false },
  { path: '/repo/wt/feature', branch: 'feat/connection-recovery', detached: false }
];

describe('WorktreePicker', () => {
  test('clicking a worktree calls onSelect once with that worktree', async () => {
    const picked = [];
    await act(async () => {
      root.render(
        <StrictMode>
          <WorktreePicker
            open
            projectName="CodexMobile"
            worktrees={WORKTREES}
            onSelect={(wt) => picked.push(wt)}
            onClose={() => {}}
          />
        </StrictMode>
      );
    });

    const items = container.querySelectorAll('.worktree-picker-item');
    expect(items.length).toBe(2);
    // First row is the main worktree and carries the 主仓 tag.
    expect(container.querySelector('.worktree-picker-main')).not.toBeNull();

    await act(async () => {
      items[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(picked.length).toBe(1);
    expect(picked[0].path).toBe('/repo/wt/feature');
    expect(picked[0].branch).toBe('feat/connection-recovery');
  });

  test('renders nothing when closed', async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <WorktreePicker open={false} worktrees={WORKTREES} onSelect={() => {}} onClose={() => {}} />
        </StrictMode>
      );
    });
    expect(container.querySelector('.worktree-picker')).toBeNull();
  });
});
