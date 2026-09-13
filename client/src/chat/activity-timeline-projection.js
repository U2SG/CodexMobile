import {
  activityTimeRange,
  buildActivityFileSummary,
  buildActivityTimeline
} from './activity-timeline-model.js';

export const TOOL_BURST_VISIBLE_COUNT = 5;

export function projectActivityView(steps, { running = false, burstVisibleCount = TOOL_BURST_VISIBLE_COUNT } = {}) {
  const sourceSteps = Array.isArray(steps) ? steps : [];
  const timeline = buildActivityTimeline(sourceSteps, running);
  return {
    timeRange: activityTimeRange(sourceSteps),
    timeline: projectActivityTimeline(timeline, { burstVisibleCount }),
    fileSummary: buildActivityFileSummary(sourceSteps)
  };
}

export function projectActivityTimeline(timeline, { burstVisibleCount = TOOL_BURST_VISIBLE_COUNT } = {}) {
  const visibleCount = Math.max(1, Number(burstVisibleCount) || TOOL_BURST_VISIBLE_COUNT);
  return (Array.isArray(timeline) ? timeline : []).map((item) => {
    if (!shouldProjectToolBurst(item, visibleCount)) {
      return item;
    }
    const items = item.items || [];
    return {
      ...item,
      type: 'metaBurst',
      visibleItems: items.slice(0, visibleCount),
      overflowItems: items.slice(visibleCount),
      hiddenCount: Math.max(0, items.length - visibleCount)
    };
  });
}

function shouldProjectToolBurst(item, visibleCount) {
  if (!item || item.type !== 'meta' || item.metaType === 'subagent') {
    return false;
  }
  const items = Array.isArray(item.items) ? item.items : [];
  return items.length > visibleCount;
}
