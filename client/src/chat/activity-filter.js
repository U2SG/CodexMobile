// Predicates for filtering which activity steps render in the chat timeline.
// Extracted from App.jsx (Batch B R8); upgraded to full upstream logic.

import { isThinkingActivityStep } from '../activity-display.js';

export function isGenericActivityLabel(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return true;
  }
  return /^(正在思考中?|思考完成|正在处理|正在回复|正在整理回复|正在准备任务|正在修改并验证|正在执行命令|命令已完成|命令完成|命令执行完成|执行完成|正在处理本地任务|本地任务已处理|本地任务失败|文件已更新|文件更新失败|正在更新文件|工具调用完成|正在调用工具|工具调用失败|正在完成一步操作|已完成一步操作|这一步操作失败|工具已完成|网页信息已查到|正在查找网页信息|计划已更新|正在规划|任务已完成|已完成|完成|失败)$/i.test(text);
}

export function isVisibleActivityStep(step, messageStatus) {
  if (!step) {
    return false;
  }
  if (step.kind === 'plan_implementation' && step.planImplementation?.completed) {
    return false;
  }
  if (isThinkingActivityStep(step)) {
    return true;
  }
  const label = String(step.label || '').trim();
  const hasWorkDetail =
    Boolean(step.command || step.detail || step.output || step.error || step.toolName) ||
    (Array.isArray(step.fileChanges) && step.fileChanges.length > 0);
  const workKinds = new Set([
    'command_execution',
    'file_change',
    'mcp_tool_call',
    'dynamic_tool_call',
    'web_search',
    'image_generation_call',
    'plan',
    'plan_implementation',
    'context_compaction',
    'subagent_activity'
  ]);
  if (isGenericActivityLabel(label) && !hasWorkDetail && !workKinds.has(step.kind)) {
    return false;
  }
  if (
    ['reasoning', 'message', 'agent_message'].includes(step.kind) &&
    /^(正在思考中?|正在处理|正在回复|正在整理回复)$/.test(label)
  ) {
    return false;
  }
  if (step.kind === 'function_call_output' && messageStatus !== 'failed' && step.status !== 'failed') {
    return false;
  }
  if (messageStatus !== 'failed' && /blocked by policy|rejected/i.test(`${step.detail || ''}\n${step.output || ''}\n${step.error || ''}`)) {
    return false;
  }
  return true;
}
