const IMPLEMENT_PLAN_REQUEST_PREFIX = 'implement-plan:';

export function extractProposedPlanContent(message) {
  const value = String(message || '').trim();
  if (!value) {
    return '';
  }
  const match = value.match(/<proposed_plan\b[^>]*>([\s\S]*?)<\/proposed_plan>/i);
  return match ? String(match[1] || '').trim() : '';
}

export function planTitleFromContent(content) {
  const lines = String(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = lines
    .map((line) => line.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim())
    .find(Boolean);
  if (heading) {
    return heading.replace(/[*_`]/g, '').trim() || '计划';
  }
  const plainLead = lines.find((line) => !/^[-*+]\s+/.test(line) && !/^\d+[.)]\s+/.test(line));
  if (plainLead && plainLead.length <= 60) {
    return plainLead.replace(/[*_`#]/g, '').trim() || '计划';
  }
  return '计划';
}

export function planMessageFromContent({ id, content, timestamp, turnId, sessionId }) {
  const planContent = String(content || '').trim();
  if (!planContent) {
    return null;
  }
  return {
    id,
    role: 'plan',
    content: planContent,
    title: planTitleFromContent(planContent),
    timestamp,
    turnId,
    sessionId
  };
}

export function planRequestMessageFromContent({
  id,
  requestId,
  content,
  timestamp,
  turnId,
  sessionId,
  completed = false
}) {
  const planContent = String(content || '').trim();
  if (!planContent) {
    return null;
  }
  const requestTurnId = String(turnId || '').trim();
  return {
    id,
    role: 'plan_request',
    content: completed ? '计划已确认执行' : '实施此计划?',
    status: completed ? 'completed' : 'running',
    timestamp,
    turnId: requestTurnId || turnId,
    sessionId,
    planImplementation: {
      requestId: requestId || (requestTurnId ? `${IMPLEMENT_PLAN_REQUEST_PREFIX}${requestTurnId}` : ''),
      turnId: requestTurnId || turnId,
      planContent,
      completed: Boolean(completed)
    }
  };
}
