import { isThinkingActivityStep, thinkingActivityText } from '../activity-display.js';
import { compactActivityText, conciseActivityDetail, isGenericActivityLabel } from './activity-model.js';

export function activityTimeRange(steps) {
  let startedAt = null;
  let endedAt = null;

  for (const step of steps || []) {
    const timestamp = step.timestamp || '';
    if (timestamp && (!startedAt || new Date(timestamp) < new Date(startedAt))) {
      startedAt = timestamp;
    }
    if (timestamp && (!endedAt || new Date(timestamp) > new Date(endedAt))) {
      endedAt = timestamp;
    }
  }

  return { startedAt, endedAt };
}

function stepsForActivityTimeline(steps) {
  const items = Array.isArray(steps) ? steps : [];
  let latestThinkingIndex = -1;
  items.forEach((step, index) => {
    if (isThinkingActivityStep(step)) {
      latestThinkingIndex = index;
    }
  });
  return items.filter((step, index) => {
    if (isThinkingActivityStep(step)) {
      return index === latestThinkingIndex;
    }
    return true;
  });
}

export function buildActivityTimeline(steps, running) {
  const timeline = [];
  let batch = [];
  let batchIndex = 0;

  function flushBatch() {
    if (!batch.length) {
      return;
    }
    timeline.push({
      id: `meta-${batchIndex++}-${batch.map((item) => item.id).join('-')}`,
      type: 'meta',
      metaType: dominantActivityType(batch),
      title: summarizeActivityBatch(batch, running),
      items: batch
    });
    batch = [];
  }

  for (const step of stepsForActivityTimeline(steps)) {
    if (isThinkingActivityStep(step)) {
      flushBatch();
      timeline.push({
        id: `thinking-${step.id}`,
        type: 'live',
        liveType: 'thinking',
        text: thinkingActivityText(step),
        status: step.status || 'running'
      });
    } else if (isContextCompactionActivity(step)) {
      flushBatch();
      timeline.push({
        id: `divider-${step.id}`,
        type: 'divider',
        text: step.status === 'running' ? '正在自动压缩上下文' : '上下文已自动压缩'
      });
    } else if (isNarrativeActivity(step)) {
      flushBatch();
      timeline.push({
        id: `text-${step.id}`,
        type: 'text',
        text: String(step.label || step.detail || step.content || '').trim()
      });
    } else {
      const item = activityTimelineItem(step);
      batch.push(item);
    }
  }
  flushBatch();

  return timeline;
}

function isContextCompactionActivity(step) {
  const source = `${step?.kind || ''} ${step?.label || ''} ${step?.detail || ''}`.trim();
  return step?.kind === 'context_compaction' || /自动压缩上下文|上下文已自动压缩/.test(source);
}

function isNarrativeActivity(step) {
  const label = String(step?.label || '').trim();
  const detail = activityDetailText(step);
  const source = `${step?.kind || ''} ${label} ${detail}`.toLowerCase();
  if (step?.command) {
    return false;
  }
  if (step?.kind === 'agent_message' || step?.kind === 'message') {
    return true;
  }
  if (/command|function_call|工具|命令|已运行|执行|编辑|修改|写入|读取|搜索|检查|查看|explore|search|read/.test(source)) {
    return false;
  }
  return label.length > 26;
}

function activityTimelineItem(step) {
  const descriptor = describeActivityStep(step);
  return {
    id: step.id,
    type: descriptor.type,
    label: descriptor.label,
    detail: descriptor.detail,
    count: descriptor.count,
    unit: descriptor.unit,
    command: step.command || '',
    output: step.output || '',
    error: step.error || '',
    exitCode: step.exitCode,
    planImplementation: step.planImplementation || null,
    subAgents: step.subAgents || [],
    status: step.status || 'running'
  };
}

function describeActivityStep(step) {
  const detail = activityDetailText(step);
  const label = String(step?.label || '').trim();
  const toolName = String(step?.toolName || '').trim();
  const command = String(step?.command || '').trim();
  const commandLike = Boolean(command) || step?.kind === 'command_execution';
  const source = `${step?.kind || ''} ${toolName} ${label} ${command} ${detail} ${step?.output || ''}`.toLowerCase();
  const directRefs = extractFileRefs([command, detail, fileChangeText(step)].filter(Boolean).join('\n'));
  const outputRefs = commandLike ? new Set() : extractFileRefs(step?.output || '');
  const fileRefs = directRefs.size ? directRefs : outputRefs;
  const count = Math.max(1, fileRefs.size || (Array.isArray(step?.fileChanges) ? step.fileChanges.length : 0));

  if (step?.kind === 'plan_implementation' || step?.kind === 'plan-implementation') {
    return {
      type: 'plan_implementation',
      label: compactActivityText(label || '等待确认执行计划'),
      detail,
      count: 1,
      unit: 'step'
    };
  }

  if (step?.kind === 'file_change' || Array.isArray(step?.fileChanges) && step.fileChanges.length) {
    return {
      type: 'edit',
      label: compactActivityText(label || '编辑文件'),
      detail: detail || compactActivityText(fileChangeText(step)),
      count,
      unit: 'file'
    };
  }

  const commandKind = classifyCommandIntent(
    command || (step?.kind === 'command_execution' ? detail : ''),
    commandLike
  );
  if (commandKind) {
    const type =
      commandKind === 'search'
        ? 'search'
        : commandKind === 'read' || commandKind === 'inspect'
          ? 'explore'
          : commandKind === 'edit'
            ? 'edit'
            : 'command';
    return {
      type,
      label: compactActivityText(label || commandActivityLabel(commandKind)),
      detail: compactActivityText(command || detail),
      count: type === 'command' || type === 'search' ? 1 : count,
      unit: type === 'command' ? 'command' : type === 'search' ? 'time' : 'file'
    };
  }

  if (step?.kind === 'web_search' || /web_search|网页搜索|搜索网页|web search/.test(source)) {
    return {
      type: 'web_search',
      label: compactActivityText(label || '网页搜索'),
      detail,
      count: 1,
      unit: 'time'
    };
  }

  if (step?.kind === 'subagent_activity' || /后台智能体|subagent|spawn_agent|wait_agent/.test(source)) {
    return {
      type: 'subagent',
      label: compactActivityText(label || '后台智能体'),
      detail,
      count: Math.max(1, Array.isArray(step?.subAgents) ? step.subAgents.length : 1),
      unit: 'agent'
    };
  }

  if (/搜索|查找|search/.test(source)) {
    return {
      type: 'search',
      label: compactActivityText(label || '搜索'),
      detail,
      count: 1,
      unit: 'time'
    };
  }

  if (/browser_|浏览器|截图|点击|导航|navigate|screenshot|click|type/.test(source)) {
    return {
      type: 'browser',
      label: compactActivityText(label || browserActivityLabel(toolName || source)),
      detail,
      count: 1,
      unit: 'action'
    };
  }

  if (/编辑|修改|写入|替换|创建|删除|updated|deleted|apply_patch/.test(source)) {
    return {
      type: 'edit',
      label: compactActivityText(label || '编辑文件'),
      detail,
      count,
      unit: 'file'
    };
  }

  if (/读取|查看|检查|探索|read|list|inspect|load_workspace_dependencies|view_image/.test(source)) {
    return {
      type: 'explore',
      label: compactActivityText(label || '探索文件'),
      detail,
      count,
      unit: 'file'
    };
  }

  if (/todo_list|计划/.test(source)) {
    return {
      type: 'plan',
      label: compactActivityText(label || '更新计划'),
      detail,
      count: 1,
      unit: 'step'
    };
  }

  return {
    type: 'tool',
    label: compactActivityText(label || (toolName ? `调用 ${toolName}` : '调用工具')),
    detail,
    count: 1,
    unit: 'step'
  };
}

function dominantActivityType(items) {
  if (items.some((item) => item.type === 'command')) {
    return 'command';
  }
  if (items.some((item) => item.type === 'edit')) {
    return 'edit';
  }
  if (items.some((item) => item.type === 'search')) {
    return 'search';
  }
  if (items.some((item) => item.type === 'web_search')) {
    return 'web_search';
  }
  if (items.some((item) => item.type === 'browser')) {
    return 'browser';
  }
  if (items.some((item) => item.type === 'explore')) {
    return 'explore';
  }
  if (items.some((item) => item.type === 'subagent')) {
    return 'subagent';
  }
  if (items.some((item) => item.type === 'plan_implementation')) {
    return 'plan_implementation';
  }
  return items[0]?.type || 'tool';
}

function summarizeActivityBatch(items, running) {
  const activeItem = items.length === 1 && running && items[0]?.status === 'running' ? items[0] : null;
  const singleItem = items.length === 1 ? items[0] : null;
  if (singleItem) {
    return activityStepDetailTitle(singleItem);
  }
  if (activeItem?.type === 'edit') {
    const detail = activeItem.detail || activeItem.label || '';
    return detail ? `正在编辑 ${conciseActivityDetail(detail)}` : '正在编辑文件';
  }
  if (activeItem?.type === 'command' && activeItem.detail) {
    return `正在运行 ${conciseActivityDetail(activeItem.detail)}`;
  }
  if ((activeItem?.type === 'search' || activeItem?.type === 'web_search') && activeItem.detail) {
    return `正在搜索 ${conciseActivityDetail(activeItem.detail)}`;
  }
  if ((activeItem?.type === 'explore' || activeItem?.type === 'browser' || activeItem?.type === 'tool') && activeItem.detail) {
    return `${activeItem.label || '正在处理'} ${conciseActivityDetail(activeItem.detail)}`;
  }
  if (activeItem?.type === 'subagent') {
    return activeItem.label || '正在运行后台智能体';
  }

  const order = [];
  const groups = items.reduce((acc, item) => {
    const key = item.type || 'tool';
    if (!acc[key]) {
      acc[key] = { steps: 0, count: 0, failed: 0, running: false, unit: item.unit || 'step' };
      order.push(key);
    }
    acc[key].steps += 1;
    acc[key].count += Number(item.count) || 1;
    acc[key].failed += item.status === 'failed' ? Number(item.count) || 1 : 0;
    acc[key].running = acc[key].running || item.status === 'running';
    return acc;
  }, {});

  function groupText(key, group) {
    const active = running && group.running;
    const doneCount = Math.max(0, group.count - group.failed);
    const failedOnly = group.failed && !doneCount && !active;
    if (key === 'search') {
      return failedOnly ? `搜索失败 ${group.failed} 次` : `${active ? '正在搜索' : '已搜索'} ${doneCount || group.count} 次`;
    }
    if (key === 'web_search') {
      return failedOnly ? `网页搜索失败 ${group.failed} 次` : `${active ? '正在搜索网页' : '已搜索网页'} ${doneCount || group.count} 次`;
    }
    if (key === 'explore') {
      return failedOnly ? `探索失败 ${group.failed} 次` : `${active ? '正在探索' : '已探索'} ${doneCount || group.count} 个文件`;
    }
    if (key === 'edit') {
      return failedOnly ? `编辑失败 ${group.failed} 个文件` : `${active ? '正在编辑' : '已编辑'} ${doneCount || group.count} 个文件`;
    }
    if (key === 'command') {
      return failedOnly ? `${group.failed} 条命令运行失败` : `${active ? '正在运行' : '已运行'} ${doneCount || group.count} 条命令`;
    }
    if (key === 'browser') {
      return failedOnly ? `浏览器操作失败 ${group.failed} 次` : `${active ? '正在操作浏览器' : '已操作浏览器'} ${doneCount || group.count} 次`;
    }
    if (key === 'plan') {
      return failedOnly ? '计划更新失败' : active ? '正在更新计划' : '已更新计划';
    }
    if (key === 'plan_implementation') {
      return failedOnly ? '计划确认失败' : active ? '等待确认执行计划' : '计划已确认执行';
    }
    if (key === 'tool') {
      if (group.failed && doneCount && !active) {
        return `已完成 ${doneCount} 步操作，${group.failed} 步操作失败`;
      }
      return failedOnly ? `${group.failed} 步操作失败` : `${active ? '正在完成' : '已完成'} ${doneCount || group.count} 步操作`;
    }
    if (key === 'subagent') {
      return failedOnly
        ? `后台智能体失败 ${group.failed} 个`
        : `${active ? '正在运行' : '已完成'} ${doneCount || group.count} 个后台智能体`;
    }
    return '';
  }

  const parts = [];
  for (const key of order) {
    const text = groupText(key, groups[key]);
    if (text) {
      parts.push(text);
    }
  }
  return parts.join('，') || '已处理';
}

export function activityDetailText(activity) {
  const label = String(activity?.label || '').trim();
  const detail = normalizeActivityDetailText(activity?.command || activity?.detail || activity?.error, activity);
  if (!detail || detail === label || isGenericActivityLabel(detail)) {
    return '';
  }
  return detail;
}

export function hasActivityStepDetail(activity) {
  return Boolean(
    activityDetailText(activity) ||
    String(activity?.command || '').trim() ||
    String(activity?.output || '').trim() ||
    String(activity?.error || '').trim()
  );
}

export function activityBodyItemsForDisplay(visibleItems, overflowItems) {
  return {
    visibleBodyItems: Array.isArray(visibleItems) ? visibleItems : [],
    overflowBodyItems: Array.isArray(overflowItems) ? overflowItems : []
  };
}

export function activityStepDetailTitle(step) {
  const detail = activityDetailText(step);
  const target = commandSemanticTarget(step.command || detail, step.type);
  const failed = step.status === 'failed';
  const running = step.status === 'running';
  const suffix = target ? ` ${conciseActivityDetail(target, 110)}` : '';

  if (step.type === 'search' || step.type === 'web_search') {
    return `${failed ? '搜索失败' : running ? '正在搜索' : '搜索'}${suffix}`;
  }
  if (step.type === 'explore') {
    return `${failed ? '读取失败' : running ? '正在读取' : '读取'}${suffix}`;
  }
  if (step.type === 'edit') {
    return `${failed ? '编辑失败' : running ? '正在编辑' : '已编辑'}${suffix}`;
  }
  if (step.type === 'browser') {
    return `${failed ? '浏览器操作失败' : running ? '正在操作浏览器' : '已操作浏览器'}${suffix}`;
  }
  if (step.type === 'tool') {
    return `${failed ? '操作失败' : running ? '正在完成操作' : '已完成操作'}${suffix}`;
  }
  if (step.type === 'plan_implementation') {
    return failed ? '计划确认失败' : running ? '等待确认执行计划' : '计划已确认执行';
  }

  const command = step.command || detail;
  return `${failed ? '运行失败' : running ? '正在运行' : '已运行'} ${conciseActivityDetail(command, 110)}`.trim();
}

function normalizeActivityDetailText(value, activity) {
  if (typeof value === 'string') {
    const detail = value.replace(/\[object Object\]\s*/g, '').trim();
    if (detail !== value.trim()) {
      return fileChangeText(activity) || detail;
    }
    return detail;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeStructuredActivityValue(item)).filter(Boolean).join('\n');
  }
  return normalizeStructuredActivityValue(value);
}

function normalizeStructuredActivityValue(value) {
  if (!value || typeof value !== 'object') {
    return String(value || '').trim();
  }
  const path = String(value.path || value.file || value.filename || '').trim();
  if (path) {
    const kind = String(value.kind || value.type || '').trim();
    return `${kind} ${path}`.trim();
  }
  return String(value.text || value.message || value.content || value.label || '').trim();
}

function fileChangeText(step) {
  return Array.isArray(step?.fileChanges)
    ? step.fileChanges.map((change) => `${change.kind || 'update'} ${change.path || ''}`.trim()).filter(Boolean).join('\n')
    : '';
}

export function buildActivityFileSummary(steps) {
  const files = new Map();
  for (const step of steps || []) {
    if (!Array.isArray(step?.fileChanges)) {
      continue;
    }
    for (const change of step.fileChanges) {
      const rawPath = String(change?.path || '').trim();
      if (!rawPath) {
        continue;
      }
      const existing = files.get(rawPath) || {
        path: rawPath,
        label: compactActivityPath(rawPath),
        additions: 0,
        deletions: 0,
        kind: change?.kind || 'update',
        diffs: [],
        signatures: new Set()
      };
      const diff = change?.unifiedDiff || change?.unified_diff || change?.diff || '';
      const stats = diffStatsFromUnifiedDiff(diff);
      const additions = Number(change?.additions) || stats.additions;
      const deletions = Number(change?.deletions) || stats.deletions;
      const signature = diff ? `diff:${diff}` : `stats:${change?.kind || 'update'}:${additions}:${deletions}`;
      existing.kind = change?.kind || existing.kind;
      if (existing.signatures.has(signature)) {
        files.set(rawPath, existing);
        continue;
      }
      existing.signatures.add(signature);
      existing.additions += additions;
      existing.deletions += deletions;
      if (diff) {
        existing.diffs.push(diff);
      }
      files.set(rawPath, existing);
    }
  }
  const items = [...files.values()].map(({ signatures, ...item }) => item);
  if (!items.length) {
    return null;
  }
  return {
    files: items,
    additions: items.reduce((total, item) => total + item.additions, 0),
    deletions: items.reduce((total, item) => total + item.deletions, 0)
  };
}

function diffStatsFromUnifiedDiff(unifiedDiff = '') {
  let additions = 0;
  let deletions = 0;
  for (const line of String(unifiedDiff || '').split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function compactActivityPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  const marker = '/CodexMobile/';
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex >= 0) {
    return normalized.slice(markerIndex + marker.length);
  }
  if (normalized.startsWith('/')) {
    const parts = normalized.split('/').filter(Boolean);
    return parts.length > 3 ? parts.slice(-3).join('/') : parts.join('/');
  }
  return normalized;
}

function classifyCommandIntent(value, assumeCommand = false) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  const lower = text.toLowerCase();
  if (/\b(apply_patch|perl\s+-0pi|python\b.*\bwrite_text|node\b.*\bwritefile|cat\s+>)/.test(lower)) {
    return 'edit';
  }
  if (/\b(rg|grep|findstr|select-string)\b/.test(lower)) {
    return 'search';
  }
  if (/\b(sed|cat|nl|head|tail|less|more|awk|jq|wc|ls|find|fd|tree)\b/.test(lower)) {
    return 'read';
  }
  if (/\bgit\s+(status|diff|show|log|ls-files|branch|rev-parse)\b/.test(lower)) {
    return 'inspect';
  }
  if (/\b(lsof|curl|ps|pwd|date|which|node\s+--check|tsc|eslint|biome|prettier|npm\s+run\s+build|npm\s+run\s+smoke|npm\s+run\s+test|pnpm|yarn|bun|pytest|vitest|jest|kill|sleep|npm\s+run\s+start|npm\s+run\s+start:bg|node\s+)/.test(lower)) {
    return 'command';
  }
  return assumeCommand ? 'command' : '';
}

function commandActivityLabel(kind) {
  if (kind === 'search') {
    return '搜索代码';
  }
  if (kind === 'read' || kind === 'inspect') {
    return '探索文件';
  }
  if (kind === 'edit') {
    return '编辑文件';
  }
  return '运行命令';
}

function unquoteShellToken(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function commandSemanticTarget(value, type = '') {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (type === 'search' || /\b(rg|grep|findstr|select-string)\b/i.test(text)) {
    const quoted = text.match(/(?:rg|grep)\s+(?:-[\w-]+\s+)*["']([^"']+)["']/i);
    if (quoted?.[1]) {
      return quoted[1];
    }
    const parts = text.split(/\s+/).slice(1).filter((part) => part && !part.startsWith('-'));
    return unquoteShellToken(parts[0] || text);
  }
  if (type === 'explore') {
    const refs = [...extractFileRefs(text)];
    if (refs.length) {
      const lastRef = refs[refs.length - 1];
      const skillName = skillNameFromPath(lastRef);
      return skillName ? `${skillName} 技能` : compactActivityPath(lastRef);
    }
  }
  return text;
}

export function isSkillActivityStep(step) {
  const values = [step?.command, step?.detail, step?.label].filter(Boolean).join('\n');
  return Boolean(skillNameFromPath(values)) || /(?:^|\s)读取\s+.+技能(?:\s|$)/.test(String(step?.label || step?.detail || ''));
}

function skillNameFromPath(value) {
  const text = String(value || '').replaceAll('\\', '/');
  const matches = [...text.matchAll(/(?:^|\/)skills\/(?:\.system\/)?([^/\s"'`]+)\/SKILL\.md\b/gi)];
  const rawName = matches.at(-1)?.[1] || '';
  if (!rawName) {
    return '';
  }
  return rawName
    .replace(/[-_]+/g, ' ')
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function browserActivityLabel(toolName) {
  const text = String(toolName || '').toLowerCase();
  if (/screenshot/.test(text)) {
    return '截取浏览器';
  }
  if (/navigate/.test(text)) {
    return '打开页面';
  }
  if (/click|type|press/.test(text)) {
    return '操作页面';
  }
  return '操作浏览器';
}

function extractFileRefs(value) {
  const refs = new Set();
  const text = String(value || '');
  const pattern = /(?:^|[\s"'`(])((?:\.{1,2}|~|\/)?[\w@.+\-~\u4e00-\u9fff]+(?:\/[\w@.+\- \u4e00-\u9fff]+)+\.(?:jsx?|tsx?|css|scss|json|md|mjs|cjs|html|yml|yaml|toml|py|sh|sql|swift|kt|java|go|rs|rb|php|txt|log)|[\w@.+\-~\u4e00-\u9fff]+\.(?:jsx?|tsx?|css|scss|json|md|mjs|cjs|html|yml|yaml|toml|py|sh|sql|swift|kt|java|go|rs|rb|php|txt|log))/g;
  for (const match of text.matchAll(pattern)) {
    const candidate = match[1]?.replace(/[,:;.)\]]+$/g, '');
    if (candidate && !candidate.startsWith('http')) {
      refs.add(candidate);
    }
  }
  return refs;
}
