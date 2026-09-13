// "近况" preview — reads /api/activity and renders a day-by-day timeline
// of recent session / file / project counts. Read-only; the data comes
// from fileSessionIndex which already drives the diff-viewer badges, so
// every number here is consistent with what shows elsewhere in the UI.

import { useEffect, useState } from 'react';
import { X, RefreshCw, Loader2 } from 'lucide-react';

import { apiFetch } from '../api.js';

const DAYS_OPTIONS = [7, 14, 30, 90];
const AGENT_OPTIONS = ['all', 'codex', 'claude'];

function formatRelativeDate(dateStr) {
  // dateStr is the UTC date the server bucketed the touch into. We
  // compare against the user's local "today" — close enough for the
  // common case, but a touch at 00:30 UTC by an Asia/Shanghai user
  // gets bucketed as today UTC while their local clock still reads
  // yesterday. When the server date is ahead of local today
  // (diffDays < 0), we fall through to the absolute date rather than
  // saying "tomorrow" — confusing but not wrong.
  if (!dateStr) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const target = new Date(y, m - 1, d);
  const diffDays = Math.round((today - target) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays > 1 && diffDays <= 6) return `${diffDays} 天前`;
  return dateStr;
}

export function ActivityPanel({ onClose }) {
  const [days, setDays] = useState(7);
  const [agent, setAgent] = useState('all');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ days: String(days) });
    if (agent !== 'all') params.set('agent', agent);
    apiFetch(`/api/activity?${params.toString()}`)
      .then((response) => {
        if (cancelled) return;
        setData(response?.activity || { days: [], totals: { sessions: 0, files: 0, projects: 0, byAgent: {} } });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || '加载失败');
        setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [days, agent]);

  return (
    <div className="activity-panel-backdrop" role="dialog" aria-label="近况" onClick={onClose}>
      <div className="activity-panel" onClick={(e) => e.stopPropagation()}>
        <header className="activity-panel-header">
          <div className="activity-panel-title">
            <strong>近况</strong>
            <span className="activity-panel-subtitle">基于 file-session 索引</span>
          </div>
          <button
            type="button"
            className="ghost-btn icon-only"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </header>

        <div className="activity-panel-controls">
          <div className="activity-panel-chip-group" aria-label="窗口">
            {DAYS_OPTIONS.map((value) => (
              <button
                key={value}
                type="button"
                className={`activity-panel-chip ${days === value ? 'is-active' : ''}`}
                onClick={() => setDays(value)}
              >
                {value}天
              </button>
            ))}
          </div>
          <div className="activity-panel-chip-group" aria-label="agent">
            {AGENT_OPTIONS.map((value) => (
              <button
                key={value}
                type="button"
                className={`activity-panel-chip ${agent === value ? 'is-active' : ''}`}
                onClick={() => setAgent(value)}
              >
                {value === 'all' ? '全部' : value === 'codex' ? 'Codex' : 'Claude'}
              </button>
            ))}
          </div>
        </div>

        {data ? (
          // Totals are period-wide unique counts (a file edited every
          // day this week counts as 1, not 7). Per-day counts shown
          // below are per-day unique. Summing them is NOT what these
          // numbers tell you.
          <div className="activity-panel-totals" title="窗口内累计独立项数">
            <div><strong>{data.totals.sessions}</strong> 个独立对话</div>
            <div><strong>{data.totals.files}</strong> 个独立文件</div>
            <div><strong>{data.totals.projects}</strong> 个独立项目</div>
          </div>
        ) : null}

        <div className="activity-panel-body">
          {loading ? (
            <div className="activity-panel-status">
              <RefreshCw size={14} className="spin" /> 加载中…
            </div>
          ) : error ? (
            <div className="banner-error">{error}</div>
          ) : !data || data.days.length === 0 ? (
            <div className="activity-panel-empty">这段时间没有 apply_patch / Write / Edit 记录</div>
          ) : (
            <ol className="activity-panel-days">
              {data.days.map((day) => (
                <li key={day.date} className="activity-panel-day">
                  <div className="activity-panel-day-date">
                    <strong>{formatRelativeDate(day.date)}</strong>
                    <small>{day.date}</small>
                  </div>
                  <div className="activity-panel-day-counts">
                    <span>{day.sessionCount} 对话</span>
                    <span>{day.fileCount} 文件</span>
                    <span>{day.projectCount} 项目</span>
                  </div>
                  {Object.keys(day.byAgent || {}).length > 1 ? (
                    <div className="activity-panel-day-agents">
                      {Object.entries(day.byAgent).map(([agentKey, slot]) => (
                        <span key={agentKey} className={`thread-source is-${agentKey}`}>
                          {agentKey === 'claude' ? 'Claude' : 'Codex'} {slot.sessions}/{slot.files}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

export default ActivityPanel;
