import { isThinkingActivityStep } from '../activity-display.js';
import { removeDuplicateFinalAnswerActivity } from '../activity-dedupe.js';
import { mergeActivityStep } from '../activity-merge.js';
import { isGenericActivityLabel, isVisibleActivityStep } from './activity-filter.js';
export { isGenericActivityLabel, isVisibleActivityStep };

export function payloadRunKeys(payload) {
  return [payload?.turnId, payload?.clientTurnId, payload?.sessionId, payload?.previousSessionId].filter(Boolean);
}

export function statusMessageId(payload) {
  return `status-${payload.clientTurnId || payload.turnId || payload.sessionId || 'current'}`;
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

function planMessageFromPayload(payload, planContent) {
  const baseId = payload.messageId || `assistant-${payload.turnId || Date.now()}`;
  const turnId = payload.turnId || null;
  return {
    id: `${baseId}-plan`,
    role: 'plan',
    content: planContent,
    title: planTitleFromContent(planContent),
    timestamp: payload.timestamp || new Date().toISOString(),
    turnId,
    sessionId: payload.sessionId || null
  };
}

function planRequestMessageFromPayload(payload, planContent) {
  const baseId = payload.messageId || `assistant-${payload.turnId || Date.now()}`;
  const turnId = payload.turnId || null;
  return {
    id: `${baseId}-plan-request`,
    role: 'plan_request',
    content: '实施此计划?',
    status: 'running',
    timestamp: payload.timestamp || new Date().toISOString(),
    turnId,
    sessionId: payload.sessionId || null,
    planImplementation: {
      requestId: turnId ? `implement-plan:${turnId}` : '',
      turnId,
      planContent,
      completed: false
    }
  };
}

function normalizedPlanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function planImplementationMatches(candidate, target) {
  if (!candidate || !target) {
    return false;
  }
  const candidateRequestId = String(candidate.requestId || '').trim();
  const targetRequestId = String(target.requestId || '').trim();
  if (candidateRequestId && targetRequestId && candidateRequestId === targetRequestId) {
    return true;
  }
  const candidateTurnId = String(candidate.turnId || '').trim();
  const targetTurnId = String(target.turnId || '').trim();
  if (candidateTurnId && targetTurnId && candidateTurnId === targetTurnId) {
    return true;
  }
  const candidatePlan = normalizedPlanText(candidate.planContent);
  const targetPlan = normalizedPlanText(target.planContent);
  return Boolean(candidatePlan && targetPlan && candidatePlan === targetPlan);
}

export function dismissPlanImplementationPrompts(current, planImplementation) {
  const target = {
    requestId: String(planImplementation?.requestId || '').trim(),
    turnId: String(planImplementation?.turnId || '').trim(),
    planContent: String(planImplementation?.planContent || '').trim()
  };
  if (!target.requestId && !target.turnId && !target.planContent) {
    return current;
  }
  return current
    .map((message) => {
      if (message.role === 'plan_request' && planImplementationMatches(message.planImplementation, target)) {
        return null;
      }
      if (message.role !== 'activity' || !Array.isArray(message.activities)) {
        return message;
      }
      let changed = false;
      const activities = message.activities.map((activity) => {
        if (activity?.kind !== 'plan_implementation' || !planImplementationMatches(activity.planImplementation, target)) {
          return activity;
        }
        changed = true;
        return {
          ...activity,
          status: 'completed',
          planImplementation: {
            ...(activity.planImplementation || {}),
            completed: true
          }
        };
      });
      return changed ? { ...message, activities } : message;
    })
    .filter(Boolean);
}

function upsertMessageById(current, message) {
  const existingIndex = current.findIndex((item) => item.id === message.id);
  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = { ...next[existingIndex], ...message };
    return next;
  }
  return [...current, message];
}

export function larkCliActivityLabel(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  if (!lower.includes('lark-cli')) {
    return '';
  }

  if (/\bauth\b/.test(lower)) {
    return '确认飞书授权';
  }

  if (/\bsheets?\b/.test(lower)) {
    if (/\+create|\bcreate\b/.test(lower)) {
      return '创建表格';
    }
    if (/\+append|\bappend\b/.test(lower)) {
      return '追加表格数据';
    }
    if (/\+write|\bwrite\b/.test(lower)) {
      return '写入表格数据';
    }
    if (/\+find|\bfind\b/.test(lower)) {
      return '查找表格内容';
    }
    if (/\+replace|\breplace\b/.test(lower)) {
      return '替换表格内容';
    }
    if (/\+export|\bexport\b/.test(lower)) {
      return '导出表格';
    }
    if (/title|rename|\bpatch\b|\bupdate\b|spreadsheet\.meta/.test(lower)) {
      return '修改表名';
    }
    if (/\+read|\bread\b|\bget\b|\bmeta\b/.test(lower)) {
      return '读取表格信息';
    }
    return '操作表格';
  }

  if (/\bslides?\b/.test(lower)) {
    if (/\+create|\bcreate\b/.test(lower)) {
      return '创建 PPT';
    }
    if (/\+update|\bupdate\b|\breplace\b|\bpatch\b/.test(lower)) {
      return '修改 PPT';
    }
    if (/\+read|\bread\b|\bget\b|\bxml_presentations\b/.test(lower)) {
      return '读取 PPT';
    }
    return '操作 PPT';
  }

  if (/\bdocs?\b/.test(lower)) {
    if (/\+create|\bcreate\b/.test(lower)) {
      return '创建文档';
    }
    if (/\+update|\bupdate\b|\bappend\b|\breplace\b|\bpatch\b/.test(lower)) {
      return '修改文档';
    }
    if (/\+search|\bsearch\b/.test(lower)) {
      return '搜索文档';
    }
    if (/\+fetch|\bread\b|\bget\b|\bfetch\b/.test(lower)) {
      return '读取文档';
    }
    return '操作文档';
  }

  if (/\bdrive\b/.test(lower)) {
    if (/\+import|\bimport\b/.test(lower)) {
      return '导入文件';
    }
    if (/\+upload|\bupload\b/.test(lower)) {
      return '上传文件';
    }
    if (/\+download|\bdownload\b/.test(lower)) {
      return '下载文件';
    }
    if (/\+delete|\bdelete\b|\btrash\b/.test(lower)) {
      return '删除文件';
    }
    if (/\+move|\bmove\b/.test(lower)) {
      return '移动文件';
    }
    if (/title|rename|\bpatch\b|\bupdate\b/.test(lower)) {
      return '修改文件名';
    }
    if (/\+search|\bsearch\b/.test(lower)) {
      return '搜索云空间';
    }
    return '操作云空间';
  }

  return '';
}

export function shellCommandActivityLabel(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  if (!text) {
    return '';
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\bvite\s+build\b|\bwebpack\b|\brollup\b/.test(lower)) {
    return '构建前端';
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?smoke\b|\bsmoke\.mjs\b/.test(lower)) {
    return '运行冒烟检查';
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\bvitest\b|\bjest\b|\bmvn\b.*\btest\b|\bcargo\s+test\b/.test(lower)) {
    return '运行测试';
  }
  if (/\bnode\s+--check\b|\btsc\b|\beslint\b|\bbiome\b|\bprettier\b|\bflake8\b|\bmypy\b/.test(lower)) {
    return '检查代码';
  }
  if (/\bgit\s+(status|diff|show|log|ls-files)\b/.test(lower)) {
    return '检查改动';
  }
  if (/\b(get-content|select-string|rg|findstr|grep)\b/.test(lower)) {
    return /\b(select-string|rg|findstr|grep)\b/.test(lower) ? '搜索代码' : '读取文件';
  }
  if (/\b(get-childitem|ls|dir)\b/.test(lower)) {
    return '查看文件';
  }
  if (/\b(start-process|node\s+server\/index\.js|node\s+server\\index\.js)\b/.test(lower)) {
    return '启动服务';
  }
  return '';
}

export function meaningfulActivityLabel(payload, rawLabel, detail) {
  const toolName = String(payload.toolName || payload.name || '').trim();
  const source = [payload.command, detail, toolName, rawLabel, payload.output]
    .filter(Boolean)
    .join(' ');
  const larkLabel = larkCliActivityLabel(source);
  if (larkLabel) {
    return larkLabel;
  }
  const commandLabel = shellCommandActivityLabel(payload.command || detail);
  if (commandLabel) {
    return commandLabel;
  }

  if (payload.kind === 'agent_message' || payload.kind === 'message') {
    const text = rawLabel || payload.content || detail;
    return isGenericActivityLabel(text) ? '' : text;
  }

  if (payload.kind === 'reasoning') {
    return briefActivityLabel(rawLabel || payload.content || detail);
  }

  if (isGenericActivityLabel(rawLabel)) {
    const toolLabel = toolActivityLabel(payload.kind, toolName || detail);
    if (toolLabel) {
      return toolLabel;
    }
    if (detail) {
      return '执行操作';
    }
  }

  if (isGenericActivityLabel(rawLabel)) {
    return '';
  }

  return rawLabel && rawLabel.length <= 18 ? rawLabel : '';
}

function toolActivityLabel(kind, value) {
  const source = `${kind || ''} ${value || ''}`.toLowerCase();
  if (!source.trim()) {
    return '';
  }
  if (/apply_patch|file_change|write|edit/.test(source)) {
    return '编辑文件';
  }
  if (/exec_command|command_execution|shell|terminal|run_command/.test(source)) {
    return '运行命令';
  }
  if (/update_plan|todo|plan/.test(source)) {
    return '更新计划';
  }
  if (/web\.run|web_search|search_query|open|find/.test(source)) {
    return '网页搜索';
  }
  if (/browser|playwright|screenshot|click|navigate|type_text/.test(source)) {
    return '操作浏览器';
  }
  if (/spawn_agent|wait_agent|subagent/.test(source)) {
    return '后台智能体';
  }
  if (/mcp_tool_call|dynamic_tool_call|custom_tool_call|function_call/.test(source)) {
    return '执行操作';
  }
  return '';
}

export function activityStepFromPayload(payload, fallbackKind = 'status') {
  const preservesText = payload.kind === 'agent_message' || payload.kind === 'message';
  const rawLabel = preservesText
    ? activityPayloadText(payload.label || payload.content).trim()
    : activityPayloadText(payload.label || payload.content).replace(/\s+/g, ' ').trim();
  const detail = activityPayloadText(payload.detail || payload.error).trim();
  const label = meaningfulActivityLabel(payload, rawLabel, detail);
  if (!label) {
    return null;
  }
  return {
    id: payload.messageId || `${statusMessageId(payload)}-${payload.kind || fallbackKind}-${label || payload.status || 'step'}`,
    kind: payload.kind || fallbackKind,
    label,
    status: payload.status || 'running',
    detail,
    command: activityPayloadText(payload.command),
    output: activityPayloadText(payload.output),
    error: activityPayloadText(payload.error),
    fileChanges: payload.fileChanges || [],
    planImplementation: payload.planImplementation || null,
    toolName: payload.toolName || payload.name || '',
    timestamp: payload.timestamp || new Date().toISOString()
  };
}

function activityPayloadText(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(activityPayloadText).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    const path = String(value.path || value.file || value.filename || '').trim();
    if (path) {
      const kind = String(value.kind || value.type || '').trim();
      return `${kind} ${path}`.trim();
    }
    return String(value.text || value.message || value.content || value.label || '').trim();
  }
  return String(value);
}

export function compactActivityText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  return text;
}

export function conciseActivityDetail(value, maxLength = 140) {
  const text = compactActivityText(value);
  if (!text || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

export function briefActivityLabel(value, fallback = '正在处理') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  if (/授权|登录|连接/.test(text)) {
    return '确认授权';
  }
  if (/记忆|skill|技能|能力|scope|权限/i.test(text)) {
    return '';
  }
  if (/搜索|查找|定位/.test(text)) {
    return '查找文件';
  }
  if (/创建|新建|生成/.test(text)) {
    return '创建文件';
  }
  if (/改名|重命名|修改标题|rename/i.test(text) && /验证|确认|检查|读取/.test(text)) {
    return '修改并验证';
  }
  if (/改名|重命名|修改标题|rename/i.test(text)) {
    return '修改标题';
  }
  if (/读取|获取|标题|内容/.test(text)) {
    return '读取内容';
  }
  if (/修改|更新|写入|追加|替换|编辑/.test(text)) {
    return '修改内容';
  }
  if (/上传|导入/.test(text)) {
    return '上传文件';
  }
  if (/下载|导出/.test(text)) {
    return '导出文件';
  }
  if (/删除|移除/.test(text)) {
    return '删除文件';
  }
  if (/验证|确认|检查/.test(text)) {
    return '验证结果';
  }
  if (/命令|lark-cli|PowerShell|shell|执行/i.test(text)) {
    return '';
  }
  return text.length > 18 ? '' : text;
}

export function isPlaceholderActivityMessage(message) {
  if (message?.role !== 'activity' || message.status === 'failed') {
    return false;
  }
  const activities = Array.isArray(message.activities) ? message.activities : [];
  if (!activities.length) {
    return false;
  }
  return !activities.some((activity) => {
    if (isThinkingActivityStep(activity)) {
      return false;
    }
    return isVisibleActivityStep(activity, message.status);
  });
}

export function shouldRenderActivityMessageInChat(message) {
  if (message?.role !== 'activity') {
    return true;
  }
  if (
    message?.transient &&
    message?.source === 'local-handoff' &&
    String(message?.status || '') !== 'failed'
  ) {
    return false;
  }
  return !isPlaceholderActivityMessage(message);
}

export function completeActivityMessagesForTurn(current, payload) {
  const keys = new Set(payloadRunKeys(payload));
  if (!keys.size) {
    return current;
  }
  const finalText = normalizeActivityDuplicateText(payload.content || payload.label || '');
  const completedAt = payload.completedAt || payload.timestamp || new Date().toISOString();
  return current.map((message) => {
    if (message.role !== 'activity' || !payloadRunKeys(message).some((key) => keys.has(key))) {
      return message;
    }
    const activities =
      finalText && Array.isArray(message.activities)
        ? message.activities.filter((activity) => {
          if (!['agent_message', 'message'].includes(activity?.kind)) {
            return true;
          }
          return normalizeActivityDuplicateText(activity.label || activity.content || activity.detail) !== finalText;
        })
        : message.activities;
    const completedActivities = Array.isArray(activities)
      ? activities.map((activity) =>
        activity?.kind === 'plan_implementation' &&
        activity.planImplementation &&
        !activity.planImplementation.completed
          ? activity
          : ['running', 'queued'].includes(String(activity?.status || ''))
          ? { ...activity, status: 'completed' }
          : activity
      )
      : activities;
    return {
      ...message,
      status: message.status === 'failed' ? 'failed' : 'completed',
      label: message.status === 'failed' ? message.label : '过程已同步',
      content: message.status === 'failed' ? message.content : '过程已同步',
      startedAt: message.startedAt || payload.startedAt || message.timestamp || null,
      completedAt: message.completedAt || completedAt,
      durationMs: message.durationMs || payload.durationMs || null,
      activities: completedActivities
    };
  });
}

export function normalizeActivityDuplicateText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function messageMatchesRun(message, keys) {
  if (!keys?.size) {
    return false;
  }
  return payloadRunKeys(message).some((key) => keys.has(key));
}

export function mergeLoadedMessagesPreservingActivity(current, loaded, payload) {
  const keys = new Set(payloadRunKeys(payload));
  if (!keys.size || !Array.isArray(loaded)) {
    return loaded || [];
  }
  if (loaded.some((message) => message.role === 'activity' && message.durationMs)) {
    return loaded;
  }
  const activityMessages = completeActivityMessagesForTurn(
    current.filter((message) => message.role === 'activity' && messageMatchesRun(message, keys)),
    payload
  );
  if (!activityMessages.length) {
    return loaded;
  }

  const result = [];
  let inserted = false;
  for (const message of loaded) {
    if (!inserted && message.role === 'assistant' && messageMatchesRun(message, keys)) {
      result.push(...removeDuplicateFinalAnswerActivity(activityMessages, { ...payload, content: message.content }));
      inserted = true;
    }
    result.push(message);
  }
  if (!inserted) {
    result.push(...activityMessages);
  }
  return result;
}

export function messageStreamSignature(messages) {
  return (messages || [])
    .map((message) => {
      const activities = Array.isArray(message.activities) ? message.activities : [];
      const activitySignature = activities
        .map((activity) => `${activity.id}:${activity.status}:${activity.label}:${activity.detail || activity.command || ''}`)
        .map((signature, index) => {
          const activity = activities[index] || {};
          const fileChanges = Array.isArray(activity.fileChanges) ? activity.fileChanges : [];
          const fileSignature = fileChanges
            .map((change) => `${change.path || ''}:${change.kind || ''}:${change.additions || 0}:${change.deletions || 0}:${String(change.unifiedDiff || '').length}`)
            .join(',');
          const output = String(activity.output || activity.error || '');
          return `${signature}:${output.length}:${output.slice(-160)}:${fileSignature}`;
        })
        .join('|');
      return `${message.id}:${message.role}:${message.status || ''}:${message.content || ''}:${activitySignature}`;
    })
    .join('\n');
}

export function upsertStatusMessage(current, payload) {
  const id = statusMessageId(payload);
  const existingIndex = current.findIndex((message) => message.id === id);
  const previous = existingIndex >= 0 ? current[existingIndex] : null;
  const normalizedPayload =
    payload.kind === 'agent_message'
      ? { ...payload, label: String(payload.label || payload.content || '').trim() }
      : payload;
  const detail =
    normalizedPayload.kind === 'reasoning'
      ? previous?.detail || ''
      : normalizedPayload.detail || previous?.detail || '';
  const isTurnLevel = normalizedPayload.kind === 'turn' || normalizedPayload.kind === 'error';
  const terminalTimestamp =
    normalizedPayload.completedAt ||
    (['completed', 'failed'].includes(normalizedPayload.status) ? normalizedPayload.timestamp : '') ||
    '';
  const nextMessage = {
    id,
    role: 'activity',
    turnId: normalizedPayload.turnId || previous?.turnId || null,
    clientTurnId: normalizedPayload.clientTurnId || previous?.clientTurnId || null,
    sessionId: normalizedPayload.sessionId || previous?.sessionId || null,
    previousSessionId: normalizedPayload.previousSessionId || previous?.previousSessionId || null,
    source: normalizedPayload.source || previous?.source || null,
    transient: normalizedPayload.transient ?? previous?.transient ?? false,
    content: isTurnLevel ? (normalizedPayload.label || previous?.content || '正在处理') : (previous?.content || '正在处理'),
    label: isTurnLevel ? (normalizedPayload.label || previous?.label || '正在处理') : (previous?.label || '正在处理'),
    detail,
    kind: normalizedPayload.kind || previous?.kind || 'turn',
    status: isTurnLevel ? (normalizedPayload.status || previous?.status || 'running') : (previous?.status || 'running'),
    timestamp: normalizedPayload.timestamp || previous?.timestamp || new Date().toISOString(),
    startedAt: previous?.startedAt || normalizedPayload.startedAt || normalizedPayload.timestamp || new Date().toISOString(),
    completedAt: previous?.completedAt || terminalTimestamp || null,
    durationMs: previous?.durationMs || normalizedPayload.durationMs || null,
    activities: mergeActivityStep(previous?.activities || [], activityStepFromPayload(normalizedPayload))
  };

  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = nextMessage;
    return next;
  }
  return [...current, nextMessage];
}

export function upsertActivityMessage(current, payload) {
  const id = statusMessageId(payload);
  const existingIndex = current.findIndex((message) => message.id === id);
  const previous = existingIndex >= 0 ? current[existingIndex] : null;
  const isTurnLevel = payload.kind === 'turn' || payload.kind === 'error';
  const activity = activityStepFromPayload(payload, 'activity');
  if (!activity && !previous) {
    return current;
  }
  const activities = activity
    ? mergeActivityStep(previous?.activities || [], activity)
    : previous?.activities || [];

  const nextMessage = {
    id,
    role: 'activity',
    turnId: payload.turnId || previous?.turnId || null,
    clientTurnId: payload.clientTurnId || previous?.clientTurnId || null,
    sessionId: payload.sessionId || previous?.sessionId || null,
    previousSessionId: payload.previousSessionId || previous?.previousSessionId || null,
    source: payload.source || previous?.source || null,
    transient: payload.transient ?? previous?.transient ?? false,
    content: previous?.content || '正在处理',
    label: previous?.label || '正在处理',
    detail: payload.detail || previous?.detail || activity?.detail || '',
    kind: payload.kind || previous?.kind || 'activity',
    status: isTurnLevel ? (payload.status || previous?.status || 'running') : (previous?.status || 'running'),
    timestamp: previous?.timestamp || payload.timestamp || new Date().toISOString(),
    startedAt: previous?.startedAt || payload.startedAt || previous?.timestamp || payload.timestamp || new Date().toISOString(),
    completedAt:
      previous?.completedAt ||
      payload.completedAt ||
      (isTurnLevel && ['completed', 'failed'].includes(payload.status) ? payload.timestamp || new Date().toISOString() : null),
    durationMs: previous?.durationMs || payload.durationMs || null,
    activities
  };

  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = nextMessage;
    return next;
  }
  return [...current, nextMessage];
}

export function completeStatusMessage(current, payload) {
  const id = statusMessageId(payload);
  return current.filter((message) => message.id !== id);
}

export function hasAssistantMessageForTurn(messages, payload) {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      payload?.turnId &&
      message.turnId === payload.turnId &&
      typeof message.content === 'string' &&
      message.content.trim()
  );
}

export function removeActivityMessagesForTurn(messages, payload) {
  const keys = new Set(payloadRunKeys(payload));
  if (!keys.size) {
    return messages;
  }
  return messages.filter((message) => {
    if (message.role !== 'activity') {
      return true;
    }
    return !payloadRunKeys(message).some((key) => keys.has(key));
  });
}

export function upsertAssistantMessage(current, payload) {
  const content = String(payload.content || '').trim();
  if (!content) {
    return current;
  }
  const proposedPlan = extractProposedPlanContent(content);
  if (proposedPlan) {
    const dedupedActivity = removeDuplicateFinalAnswerActivity(current, { ...payload, content: proposedPlan });
    const withCompletedActivity = payload.done === false
      ? dedupedActivity
      : completeActivityMessagesForTurn(dedupedActivity, { ...payload, content: proposedPlan });
    return upsertMessageById(
      upsertMessageById(withCompletedActivity, planMessageFromPayload(payload, proposedPlan)),
      planRequestMessageFromPayload(payload, proposedPlan)
    );
  }
  const turnId = payload.turnId || null;
  const msgId = payload.messageId || `assistant-${turnId || Date.now()}`;
  const dedupedActivity = removeDuplicateFinalAnswerActivity(current, payload);
  const withCompletedActivity = payload.done === false ? dedupedActivity : completeActivityMessagesForTurn(dedupedActivity, payload);
  // Same-turn merge: Claude can emit multiple Anthropic messages per user
  // turn (text → tool_use → text), each with its own msg_xxx. Previously
  // each became a separate bubble. We now anchor to the first assistant
  // message of the turn and track per-msgId content in `segments`, so
  // partial-stream updates of any segment still replace only that segment.
  const existingIndex = turnId
    ? withCompletedActivity.findIndex((message) => message.role === 'assistant' && message.turnId === turnId)
    : withCompletedActivity.findIndex((message) => message.id === msgId);
  if (existingIndex >= 0) {
    const existing = withCompletedActivity[existingIndex];
    const segments = new Map(existing.segments || [[existing.id, existing.content || '']]);
    segments.set(msgId, content);
    const joined = Array.from(segments.values()).map((segment) => String(segment || '').trim()).filter(Boolean).join('\n\n');
    const next = [...withCompletedActivity];
    next[existingIndex] = {
      ...existing,
      content: joined,
      segments,
      timestamp: new Date().toISOString(),
      kind: payload.kind || existing.kind
    };
    return next;
  }
  return [...withCompletedActivity, {
    id: msgId,
    role: 'assistant',
    content,
    segments: new Map([[msgId, content]]),
    timestamp: new Date().toISOString(),
    turnId,
    sessionId: payload.sessionId || null,
    kind: payload.kind
  }];
}
