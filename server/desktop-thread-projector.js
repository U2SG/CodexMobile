import { imageMarkdownFromCodexImageGeneration } from './codex-native-images.js';
import { statusLabel } from './codex-runner.js';

const INTERNAL_PROMPT_MARKERS = [
  'CodexMobile iOS/PWA 回复要求：',
  'CodexMobile 已接入飞书官方 lark-cli。',
  'CodexMobile 已接入飞书官方 lark-cli'
];
const IMPLEMENT_PLAN_PROMPT_PREFIX = 'PLEASE IMPLEMENT THIS PLAN:';
const IMPLEMENT_PLAN_REQUEST_PREFIX = 'implement-plan:';
const GUIDED_USER_LABEL = '已引导对话';

// Codex injects these blocks as "user" turns (repo AGENTS.md, environment
// snapshot, plugin catalogue, interruption marker). They carry no conversation
// value: never render them as a user bubble, never count them, never let one
// become a session title.
const CODEX_SYSTEM_NOISE_PREFIXES = [
  '# AGENTS.md instructions',
  '<environment_context>',
  '<recommended_plugins>',
  '<turn_aborted>',
  '<user_instructions>'
];

export function isCodexSystemNoiseBlock(message) {
  const value = String(message || '').trimStart();
  return CODEX_SYSTEM_NOISE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function guidedUserMetadata(enabled) {
  return enabled
    ? { guided: true, guideLabel: GUIDED_USER_LABEL, kind: 'guided_user' }
    : {};
}

function normalizePlanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function implementedPlanContentFromMessage(message) {
  const value = String(message || '').trim();
  if (!value.startsWith(IMPLEMENT_PLAN_PROMPT_PREFIX)) {
    return '';
  }
  return value.slice(IMPLEMENT_PLAN_PROMPT_PREFIX.length).trim();
}

export function sanitizeVisibleUserMessage(message) {
  const value = String(message || '').trim();
  if (!value) {
    return '';
  }
  if (value.startsWith(IMPLEMENT_PLAN_PROMPT_PREFIX)) {
    return '执行计划';
  }
  let cutAt = value.length;
  for (const marker of INTERNAL_PROMPT_MARKERS) {
    const index = value.indexOf(marker);
    if (index > 0) {
      cutAt = Math.min(cutAt, index);
    }
  }
  return value.slice(0, cutAt).trim() || value;
}

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

function textFromDesktopContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      return part?.text || part?.content || part?.message || '';
    })
    .filter(Boolean)
    .join('\n');
}

function desktopItemRole(item) {
  if (item?.role === 'user' || item?.role === 'assistant') return item.role;
  if (item?.type === 'userMessage' || item?.type === 'user_message') return 'user';
  // Codex 0.149+ renamed the assistant item to `agentMessage` and moved its
  // body to `item.text`, with `phase` splitting narration (commentary) from
  // the reply (final_answer). Older builds shipped assistantMessage/message.
  if (item?.type === 'agentMessage' || item?.type === 'agent_message') return 'assistant';
  if (item?.type === 'assistantMessage' || item?.type === 'assistant_message' || item?.type === 'message') {
    return item?.role === 'user' ? 'user' : 'assistant';
  }
  return '';
}

// Only the final answer becomes an assistant bubble; the "I'll go do X" turn
// narration folds into the collapsed activity layer instead.
export function isCommentaryPhase(item) {
  return String(item?.phase || '') === 'commentary';
}

export function commentaryActivity(text, { id, turnId, timestamp }) {
  const label = String(text || '').trim();
  if (!label) {
    return null;
  }
  return {
    id: id || `${turnId}-commentary`,
    kind: 'agent_message',
    label,
    status: 'completed',
    detail: '',
    command: '',
    output: '',
    timestamp
  };
}

function desktopItemText(item) {
  if (item?.type === 'image_generation') {
    return imageMarkdownFromCodexImageGeneration(item);
  }
  return textFromDesktopContent(item?.content ?? item?.message ?? item?.text ?? item?.input);
}

function desktopItemTimestamp(item, turn) {
  return item?.timestamp || item?.createdAt || turn?.timestamp || turn?.startedAt || new Date().toISOString();
}

function implementedPlanContentsFromTurns(turns) {
  const contents = new Set();
  for (const turn of Array.isArray(turns) ? turns : []) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (desktopItemRole(item) !== 'user') continue;
      const content = implementedPlanContentFromMessage(desktopItemText(item));
      if (content) contents.add(normalizePlanText(content));
    }
  }
  return contents;
}

function desktopActivityMessageId(turnId, segmentIndex = 0) {
  return segmentIndex > 0 ? `activity-${turnId}-${segmentIndex}` : `activity-${turnId}`;
}

function findDesktopActivityInsertIndex(messages, turnId, segmentIndex) {
  let userCount = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.turnId !== turnId) continue;
    if (message.role === 'user') {
      const currentSegment = Number.isFinite(Number(message.segmentIndex)) ? Number(message.segmentIndex) : userCount;
      if (currentSegment === segmentIndex) {
        return index + 1;
      }
      userCount += 1;
    }
  }
  let lastTurnIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.turnId === turnId) {
      lastTurnIndex = index;
    }
  }
  return lastTurnIndex >= 0 ? lastTurnIndex + 1 : messages.length;
}

export function upsertDesktopActivity(messages, turnId, activity, segmentIndex = 0) {
  if (!activity || !turnId) {
    return;
  }
  const normalizedSegment = Math.max(0, Number(segmentIndex) || 0);
  const id = desktopActivityMessageId(turnId, normalizedSegment);
  const existing = messages.find((message) => message.id === id);
  if (existing) {
    const current = Array.isArray(existing.activities) ? existing.activities : [];
    const index = current.findIndex((item) => item.id === activity.id);
    const nextActivities = [...current];
    if (index >= 0) {
      nextActivities[index] = { ...nextActivities[index], ...activity };
    } else {
      nextActivities.push(activity);
    }
    existing.activities = nextActivities;
    existing.timestamp = nextActivities[0]?.timestamp || existing.timestamp;
    return;
  }
  const message = {
    id,
    role: 'activity',
    content: '',
    turnId,
    segmentIndex: normalizedSegment,
    timestamp: activity.timestamp || new Date().toISOString(),
    activities: [activity]
  };
  messages.splice(findDesktopActivityInsertIndex(messages, turnId, normalizedSegment), 0, message);
}

export function removeFallbackActivitiesCoveredByRaw(messages, rawActivities) {
  if (!Array.isArray(messages) || !Array.isArray(rawActivities) || rawActivities.length === 0) {
    return;
  }
  const rawKindsByTurn = new Map();
  for (const item of rawActivities) {
    if (!item?.turnId || !item.activity?.kind) continue;
    if (!rawKindsByTurn.has(item.turnId)) rawKindsByTurn.set(item.turnId, new Set());
    rawKindsByTurn.get(item.turnId).add(item.activity.kind);
  }
  for (const message of messages) {
    if (message?.role !== 'activity' || !rawKindsByTurn.has(message.turnId)) continue;
    const kinds = rawKindsByTurn.get(message.turnId);
    message.activities = (message.activities || []).filter((activity) => !kinds.has(activity.kind));
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'activity' && !(messages[index].activities || []).length) {
      messages.splice(index, 1);
    }
  }
}

function activityTime(activity) {
  const value = Date.parse(activity?.timestamp || '');
  return Number.isFinite(value) ? value : 0;
}

export function sortDesktopActivitySteps(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'activity' && Array.isArray(message.activities)) {
      message.activities.sort((left, right) => activityTime(left) - activityTime(right));
      message.timestamp = message.activities[0]?.timestamp || message.timestamp;
    }
  }
}

function activityFromDesktopItem(item, turn) {
  const kind = item?.kind || item?.type || '';
  if (!kind || kind === 'message' || kind === 'userMessage' || kind === 'assistantMessage') {
    return null;
  }
  const status = item?.status || (item?.error ? 'failed' : 'completed');
  return {
    id: item?.id || `${turn?.id || 'turn'}-${kind}`,
    kind,
    status,
    label: item?.label || statusLabel(kind, status),
    detail: item?.detail || item?.command || item?.path || '',
    command: item?.command || '',
    output: item?.output || '',
    timestamp: desktopItemTimestamp(item, turn)
  };
}

export function messagesFromDesktopThread(thread, { includeActivity = false } = {}) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const messages = [];
  const implementedPlanContents = implementedPlanContentsFromTurns(turns);
  for (const turn of turns) {
    const turnId = turn?.id || turn?.turnId || thread?.id || 'turn';
    let userIndex = 0;
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      const role = desktopItemRole(item);
      if (!role) {
        if (includeActivity) {
          const activity = activityFromDesktopItem(item, turn);
          if (activity) {
            upsertDesktopActivity(messages, turnId, activity, Number(item?.segmentIndex) || 0);
          }
        }
        continue;
      }
      const rawText = desktopItemText(item);
      if (role === 'user' && isCodexSystemNoiseBlock(rawText)) continue;
      const content = role === 'user' ? sanitizeVisibleUserMessage(rawText) : rawText;
      if (!content) continue;
      const timestamp = desktopItemTimestamp(item, turn);
      if (role === 'assistant' && isCommentaryPhase(item)) {
        if (includeActivity) {
          const activity = commentaryActivity(content, {
            id: item?.id ? `${item.id}-commentary` : `${turnId}-commentary-${messages.length + 1}`,
            turnId,
            timestamp
          });
          if (activity) {
            upsertDesktopActivity(messages, turnId, activity, Number(item?.segmentIndex) || 0);
          }
        }
        continue;
      }
      if (role === 'assistant') {
        const proposedPlan = extractProposedPlanContent(content);
        if (proposedPlan) {
          const baseId = item?.id || `${turnId}-assistant-${messages.length + 1}`;
          const plan = planMessageFromContent({ id: `${baseId}-plan`, content: proposedPlan, timestamp, turnId, sessionId: thread?.id });
          const request = planRequestMessageFromContent({
            id: `${baseId}-plan-request`,
            requestId: `${IMPLEMENT_PLAN_REQUEST_PREFIX}${turnId}`,
            content: proposedPlan,
            timestamp,
            turnId,
            sessionId: thread?.id
          });
          if (plan) messages.push(plan);
          if (request && !implementedPlanContents.has(normalizePlanText(proposedPlan))) messages.push(request);
          continue;
        }
      }
      messages.push({
        id: item?.id || `${turnId}-${role}-${messages.length + 1}`,
        role,
        content,
        timestamp,
        turnId,
        sessionId: thread?.id,
        segmentIndex: role === 'user' ? userIndex : undefined,
        ...(role === 'user' ? guidedUserMetadata(userIndex > 0) : {})
      });
      if (role === 'user') {
        userIndex += 1;
      }
    }
  }
  return messages;
}
