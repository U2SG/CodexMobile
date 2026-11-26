import { normalizeAgentId } from './runtime-capabilities.js';

export function providerFromStatus(statusOrProvider) {
  return typeof statusOrProvider === 'string'
    ? statusOrProvider
    : statusOrProvider?.provider;
}

export function isClaudeProvider(statusOrProvider) {
  return normalizeAgentId(providerFromStatus(statusOrProvider)) === 'claude';
}

export function isAgyProvider(statusOrProvider) {
  return normalizeAgentId(providerFromStatus(statusOrProvider)) === 'agy';
}

export function isCodexProvider(statusOrProvider) {
  return normalizeAgentId(providerFromStatus(statusOrProvider)) === 'codex';
}

export function sessionSourceBadge(provider, fallbackLabel = 'Codex') {
  if (isClaudeProvider(provider)) return { className: 'is-claude', label: 'Claude' };
  if (isAgyProvider(provider)) return { className: 'is-agy', label: 'AGY' };
  if (provider) return { className: 'is-codex', label: 'Codex' };
  return { className: 'is-codex', label: fallbackLabel };
}

// Multi-state agent metadata.
//
// `id` is one of 'claude' | 'agy' | 'codex' | 'unknown'. The 'unknown' case
// fires while /api/status hasn't returned yet and prevents route-conditional UI
// from briefly flashing the wrong route's chrome. Route-specific renders should
// use strict `agent.id === 'claude' / 'agy' / 'codex'`.
export function agentMeta(statusOrProvider) {
  const agentId = normalizeAgentId(providerFromStatus(statusOrProvider));
  if (agentId === 'unknown') {
    return {
      id: 'unknown',
      label: 'CodexMobile',
      shortLabel: 'CodexMobile',
      providerLabel: '正在连接',
      pairingTitle: '连接 CodexMobile',
      pairingHint: '输入服务启动时设置的配对码。',
      emptyTitle: 'CodexMobile 工作台',
      emptyBody: '正在连接服务…',
      placeholder: '请稍候',
      newConversationHint: '正在连接',
      activityRunning: '正在连接',
      accentClass: ''
    };
  }
  if (agentId === 'agy') {
    return {
      id: 'agy',
      label: 'AGY',
      shortLabel: 'AGY',
      providerLabel: 'AGY CLI',
      pairingTitle: '连接 AGY',
      pairingHint: '输入 AGY 服务启动时设置的配对码。',
      emptyTitle: 'AGY 工作台',
      emptyBody: '选择项目后发起任务，AGY 会在电脑上的仓库里读取、修改和验证。',
      placeholder: '交给 AGY 处理',
      newConversationHint: '在当前项目交给 AGY',
      activityRunning: 'AGY 正在处理',
      accentClass: 'is-agy'
    };
  }
  const claude = agentId === 'claude';
  return {
    id: claude ? 'claude' : 'codex',
    label: claude ? 'Claude Code' : 'Codex',
    shortLabel: claude ? 'Claude' : 'Codex',
    providerLabel: claude ? 'Claude CLI' : 'Codex SDK',
    pairingTitle: claude ? '连接 Claude Code' : '连接 Codex',
    pairingHint: claude ? '输入 Claude 服务启动时设置的配对码。' : '输入 Codex 服务启动时设置的配对码。',
    emptyTitle: claude ? 'Claude Code 工作台' : 'Codex 工作台',
    emptyBody: claude ? '选择项目后发起任务，Claude 会在电脑上的仓库里读取、修改和验证。' : '选择项目后发起任务，Codex 会在电脑上的仓库里执行。',
    placeholder: claude ? '交给 Claude Code 处理' : '给 Codex 发送消息',
    newConversationHint: claude ? '在当前项目交给 Claude' : '在当前项目中新建',
    activityRunning: claude ? 'Claude 正在处理' : '正在思考中',
    accentClass: claude ? 'is-claude' : 'is-codex'
  };
}
