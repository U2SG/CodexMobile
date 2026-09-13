import { normalizeAgentId } from './runtime-capabilities.js';

export function providerFromStatus(statusOrProvider) {
  return typeof statusOrProvider === 'string'
    ? statusOrProvider
    : statusOrProvider?.provider;
}

export function isClaudeProvider(statusOrProvider) {
  return normalizeAgentId(providerFromStatus(statusOrProvider)) === 'claude';
}

export function isCodexProvider(statusOrProvider) {
  return normalizeAgentId(providerFromStatus(statusOrProvider)) === 'codex';
}

// Three-state agent metadata.
//
// `id` is one of 'claude' | 'codex' | 'unknown'. The 'unknown' case fires
// while /api/status hasn't returned yet and prevents route-conditional UI
// (Drawer codex sections, claude-only branding, etc.) from briefly flashing
// the wrong route's chrome. Route-specific renders should use strict
// `agent.id === 'claude' / 'codex'`.
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
