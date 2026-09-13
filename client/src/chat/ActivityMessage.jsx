import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatDuration, formatDurationMs } from '../format-time.js';
import { activityCardShouldOpen } from './activity-card-state.js';
import { isVisibleActivityStep, shouldRenderActivityMessageInChat } from './activity-model.js';
import { ActivityTimeline } from './ActivityTimeline.jsx';
import { projectActivityView } from './activity-timeline-projection.js';

function hasPendingPlanImplementation(activities = []) {
  return activities.some((activity) =>
    activity?.kind === 'plan_implementation' &&
    activity.planImplementation &&
    !activity.planImplementation.completed
  );
}

export function ActivityMessage({ message, now = Date.now(), onImplementPlan, turnPosition = 'sole' }) {
  if (!shouldRenderActivityMessageInChat(message)) {
    return null;
  }
  const activities = message.activities || [];
  const pendingPlanImplementation = hasPendingPlanImplementation(activities);
  const running = message.status === 'running' || message.status === 'queued';
  const failed = message.status === 'failed';
  const visibleSteps = activities.filter((activity) => isVisibleActivityStep(activity, message.status));
  const { timeRange, timeline, fileSummary } = projectActivityView(visibleSteps, { running });
  const hasProcess = timeline.length > 0 || Boolean(fileSummary);
  const [open, setOpen] = useState(() => pendingPlanImplementation || activityCardShouldOpen({ running, hasProcess }));
  const startedAt = message.startedAt || timeRange.startedAt || message.timestamp;
  const endedAt = running ? now : message.completedAt || timeRange.endedAt || message.timestamp || now;
  const duration = !running ? formatDurationMs(message.durationMs) || formatDuration(startedAt, endedAt) : formatDuration(startedAt, endedAt);
  const headline = failed
    ? '\u5904\u7406\u5931\u8d25'
    : pendingPlanImplementation
      ? '\u7b49\u5f85\u786e\u8ba4'
      : running
        ? '\u6b63\u5728\u5904\u7406'
        : '\u5df2\u5904\u7406';
  const stepCount = visibleSteps.length;
  const processLabel = hasProcess
    ? stepCount
      ? ` / ${stepCount} \u6b65`
      : ` / \u6587\u4ef6\u53d8\u66f4`
    : '';
  const summaryText = `${headline}${duration ? ` ${duration}` : ''}${processLabel}`;

  useEffect(() => {
    setOpen(pendingPlanImplementation || activityCardShouldOpen({ running, hasProcess }));
  }, [message.id, running, hasProcess, pendingPlanImplementation]);

  return (
    <div className="message-row is-activity" data-turn-position={turnPosition}>
      <div className={`message-bubble activity-bubble ${failed ? 'is-failed' : ''} ${running ? 'is-running' : ''} ${open ? 'is-open' : ''}`}>
        <button
          type="button"
          className="activity-summary"
          aria-expanded={hasProcess ? open : undefined}
          aria-label={hasProcess ? `${summaryText}，${open ? '\u6536\u8d77' : '\u5c55\u5f00'}\u8be6\u60c5` : summaryText}
          disabled={!hasProcess}
          onClick={() => setOpen((value) => !value)}
        >
          <span>{summaryText}</span>
          {hasProcess ? <ChevronDown className={`activity-chevron ${open ? 'is-open' : ''}`} size={15} /> : null}
        </button>
        {open && hasProcess ? (
          <ActivityTimeline
            timeline={timeline}
            fileSummary={fileSummary}
            onImplementPlan={onImplementPlan}
          />
        ) : null}
      </div>
    </div>
  );
}
