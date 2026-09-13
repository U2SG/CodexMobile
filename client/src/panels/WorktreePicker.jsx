// Worktree picker — shown when starting a new conversation in a git repo that
// has more than one worktree. Lets the user pick which worktree the new
// session runs in (its cwd). The first entry is the main worktree and is the
// default. Read-only: creating/removing worktrees stays on the desktop.
//
// Rendered by App.jsx only when /api/git/worktrees returns >1 entry; single
// worktree / non-repo / fetch failure falls through to the project root with
// no picker (handled by the caller).

import { Folder, GitBranch, X } from 'lucide-react';
import { compactPath } from '../utils/path.js';

const backdropStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 95, padding: 12
};
const shellStyle = {
  background: 'var(--panel)', borderRadius: 14, maxWidth: 460, width: '100%',
  maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 20px 50px rgba(0,0,0,0.25)'
};

export function WorktreePicker({ open, projectName, worktrees, onSelect, onClose }) {
  if (!open) {
    return null;
  }
  const items = Array.isArray(worktrees) ? worktrees : [];
  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={shellStyle} className="worktree-picker" onClick={(event) => event.stopPropagation()}>
        <div className="worktree-picker-header">
          <strong>选择 worktree</strong>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="worktree-picker-sub">{projectName} 有多个 worktree，新对话在哪个里运行？</div>
        <ul className="worktree-picker-list">
          {items.map((wt, index) => (
            <li key={wt.path}>
              <button
                type="button"
                className="worktree-picker-item"
                onClick={() => onSelect(wt)}
              >
                <span className="worktree-picker-icon">
                  {index === 0 ? <Folder size={16} /> : <GitBranch size={16} />}
                </span>
                <span className="worktree-picker-text">
                  <strong>
                    {wt.branch || (wt.detached ? '(detached HEAD)' : '(无分支)')}
                    {index === 0 ? <small className="worktree-picker-main">主仓</small> : null}
                  </strong>
                  <small title={wt.path}>{compactPath(wt.path)}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
