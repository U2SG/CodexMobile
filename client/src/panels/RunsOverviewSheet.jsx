// "进行中" sheet: every conversation on this service that is waiting on an
// approval, running, or has queued messages. Tapping a row opens it.

import { AlertTriangle, CircleDot, Clock, X } from 'lucide-react';

import { runContextLine, runStatusText } from './runs-overview-format.js';

const STATUS_ICON = { approval: AlertTriangle, running: CircleDot, queued: Clock };

export function RunsOverviewSheet({ runs, onSelect, onClose }) {
  const now = Date.now();
  return (
    <div className="approval-sheet runs-sheet" role="dialog" aria-modal="true" aria-label="进行中的会话">
      <div className="approval-sheet__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="approval-sheet__panel">
        <div className="approval-sheet__header">
          <h3>进行中的会话</h3>
          <button type="button" className="icon-button runs-sheet__close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        {runs.length ? (
          <ul className="runs-sheet__list">
            {runs.map((run) => {
              const Icon = STATUS_ICON[run.status] || CircleDot;
              return (
                <li key={run.sessionId}>
                  <button type="button" className={`runs-sheet__row is-${run.status}`} onClick={() => onSelect(run)}>
                    <span className="runs-sheet__status">
                      <Icon size={14} aria-hidden="true" />
                      {runStatusText(run, now)}
                    </span>
                    <strong className="runs-sheet__title">{run.title}</strong>
                    <small className="runs-sheet__context">{runContextLine(run)}</small>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="runs-sheet__empty">没有进行中的会话。</p>
        )}
      </div>
    </div>
  );
}
