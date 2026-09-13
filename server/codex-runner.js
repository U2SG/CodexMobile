import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildCodexLarkCliContext } from './lark-cli.js';
import { detectFeishuSkillKeys } from './feishu-skills.js';
import { isClaudeMode } from './agent-mode.js';
import { readCodexModels } from './codex-config.js';
import { claudeAssistantMessageId, createClaudePartialStreamState, processClaudePartialStreamEvent } from './claude-stream.js';
import { buildClaudeSkillsAppendix } from './claude-skills.js';
import { getClaudeHookSecret } from './approval-pool.js';

const CLAUDE_APPROVAL_HOOK_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'claude-approval-hook.mjs'
);

// Compose a settings JSON that adds our PreToolUse hook entry while
// preserving every hook the user has configured at the user or project
// level. Claude's `--settings` flag does a top-level merge — passing
// `{hooks:{...}}` REPLACES the entire `hooks` object from lower-precedence
// sources, including unrelated hook events like SessionEnd. To avoid
// stomping the user's other lifecycle hooks, we read those sources here
// and union them with our own entry before writing the temp file.
// Tools that mutate state or run arbitrary code on the host — the ones
// worth surfacing to the user. Reads, Globs, Greps, todo updates, and
// task delegation are left to acceptEdits's default allow so we don't
// nag on every safe lookup. MCP tool calls are deliberately not matched
// either; the matcher would fire on dozens of harmless server lookups
// during a normal turn. Bash is the catch-all riskiest one.
//
// AskUserQuestion is matched not because it's risky, but because in headless
// `--print` mode there is no TTY for Claude to ask the question on. The hook
// is the only place we can intercept the questions, surface them as a form in
// the PWA, and inject the user's choice back via the supported PreToolUse
// `allow` + `updatedInput.answers` mechanism (see claude-approval-route.js).
const CLAUDE_APPROVAL_HOOK_MATCHERS = [
  'Bash',
  'PowerShell',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'AskUserQuestion'
];

async function buildClaudeSettingsWithApprovalHook(workingDirectory) {
  const hookCommand = `node "${CLAUDE_APPROVAL_HOOK_PATH}"`;
  const ourEntries = CLAUDE_APPROVAL_HOOK_MATCHERS.map((matcher) => ({
    matcher,
    hooks: [{ type: 'command', command: hookCommand }]
  }));
  const mergedHooks = {};
  const sources = [
    path.join(os.homedir(), '.claude', 'settings.json'),
    workingDirectory ? path.join(workingDirectory, '.claude', 'settings.json') : null
  ].filter(Boolean);
  for (const file of sources) {
    let parsed;
    try {
      const raw = await fs.readFile(file, 'utf8');
      parsed = JSON.parse(raw);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EISDIR') {
        console.warn(`[claude-hook] ignoring unreadable ${file}: ${error.message}`);
      }
      continue;
    }
    const events = parsed?.hooks;
    if (!events || typeof events !== 'object') continue;
    for (const [eventName, entries] of Object.entries(events)) {
      if (!Array.isArray(entries)) continue;
      if (!mergedHooks[eventName]) mergedHooks[eventName] = [];
      mergedHooks[eventName].push(...entries);
    }
  }
  if (!mergedHooks.PreToolUse) mergedHooks.PreToolUse = [];
  mergedHooks.PreToolUse.push(...ourEntries);
  return { hooks: mergedHooks };
}

const activeRuns = new Map();
// Module-private but readable through `getActiveRunRegistry()` so the
// app-server runner can register itself for `abortCodexTurn` interop.
export function getActiveRunRegistry() {
  return activeRuns;
}
const NON_ASCII_PATH_PATTERN = /[^\u0000-\u007F]/;
async function ensureAsciiWorkingDirectory(projectPath) {
  if (process.platform !== 'win32' || !NON_ASCII_PATH_PATTERN.test(projectPath)) {
    return projectPath;
  }

  const resolved = path.resolve(projectPath);
  const driveRoot = path.parse(resolved).root || 'C:\\';
  const aliasRoot = path.join(driveRoot, 'codex_project_aliases');
  const aliasName = crypto.createHash('sha1').update(resolved.toLowerCase()).digest('hex');
  const aliasPath = path.join(aliasRoot, aliasName);

  await fs.mkdir(aliasRoot, { recursive: true });
  try {
    const stats = await fs.lstat(aliasPath);
    if (stats.isDirectory() || stats.isSymbolicLink()) {
      return aliasPath;
    }
    await fs.rm(aliasPath, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.symlink(resolved, aliasPath, 'junction');
  return aliasPath;
}

function mapPermissionMode(permissionMode) {
  if (permissionMode === 'bypassPermissions') {
    return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' };
  }
  if (permissionMode === 'acceptEdits') {
    return { sandboxMode: 'workspace-write', approvalPolicy: 'never' };
  }
  return { sandboxMode: 'workspace-write', approvalPolicy: 'never' };
}

function normalizeReasoningEffort(reasoningEffort) {
  const value = String(reasoningEffort || '').trim();
  return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value) ? value : undefined;
}

function textFromContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part?.type === 'output_text' || part?.type === 'input_text' || part?.type === 'text') {
        return part.text || '';
      }
      return part?.text || '';
    })
    .filter(Boolean)
    .join('\n');
}

function contentFromItem(item) {
  if (!item) {
    return '';
  }
  const contentText = textFromContent(item.content);
  if (contentText) {
    return contentText;
  }
  if (typeof item.text === 'string') {
    return item.text;
  }
  if (typeof item.aggregated_output === 'string') {
    return item.aggregated_output;
  }
  if (typeof item.message === 'string') {
    return item.message;
  }
  return '';
}

export function statusLabel(kind, status = 'running') {
  const done = status === 'completed';
  const failed = status === 'failed';
  const labels = {
    turn: done ? '任务已完成' : failed ? '任务失败' : '正在处理',
    reasoning: done ? '思考完成' : '正在思考',
    agent_message: '正在回复',
    message: '正在回复',
    command_execution: done ? '命令已完成' : failed ? '命令失败' : '正在执行命令',
    file_change: done ? '文件已修改' : failed ? '文件修改失败' : '正在修改文件',
    mcp_tool_call: done ? '工具调用完成' : failed ? '工具调用失败' : '正在调用工具',
    web_search: done ? '搜索完成' : failed ? '搜索失败' : '正在搜索',
    todo_list: done ? '计划已更新' : '正在规划',
    image_generation_call: done ? '图片生成完成' : failed ? '图片生成失败' : '正在生成图片',
    custom_tool_call: done ? '工具调用完成' : failed ? '工具调用失败' : '正在调用工具',
    function_call: done ? '工具调用完成' : failed ? '工具调用失败' : '正在调用工具',
    error: '出现错误'
  };
  return labels[kind] || (done ? '已完成' : failed ? '失败' : '正在处理');
}

function compactStatusLabel(content, fallback = '正在处理') {
  const label = String(content || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!label) {
    return fallback;
  }
  return label.length > 68 ? `${label.slice(0, 68)}...` : label;
}

function detailFromItem(item) {
  if (!item) {
    return '';
  }
  if (item.command) {
    return item.command;
  }
  if (item.query) {
    return item.query;
  }
  if (item.tool || item.server) {
    return [item.server, item.tool].filter(Boolean).join(' / ');
  }
  if (Array.isArray(item.changes)) {
    return item.changes.map((change) => `${change.kind || 'update'} ${change.path}`).join('\n');
  }
  if (item.message) {
    return item.message;
  }
  return contentFromItem(item);
}

function eventItem(event) {
  if (event.item) {
    return event.item;
  }
  if (event.payload && (event.type === 'response_item' || event.type === 'event_msg')) {
    return event.payload;
  }
  return null;
}

function eventStatus(event, item) {
  if (item?.status) {
    if (item.status === 'in_progress') {
      return 'running';
    }
    return item.status;
  }
  if (event.type === 'item.completed') {
    return 'completed';
  }
  if (event.type === 'item.started' || event.type === 'item.updated') {
    return 'running';
  }
  if (event.type === 'event_msg' && item?.type?.endsWith('_end')) {
    return item.exit_code || item.exit_code === 0 ? (item.exit_code === 0 ? 'completed' : 'failed') : 'completed';
  }
  if (event.type === 'response_item') {
    return 'completed';
  }
  return 'running';
}

function emitStatus(emit, { sessionId, turnId, kind, status = 'running', label, detail = '' }) {
  emit({
    type: 'status-update',
    sessionId,
    turnId,
    kind,
    status,
    label: label || statusLabel(kind, status),
    detail,
    timestamp: new Date().toISOString()
  });
}

function isSpawnPermissionError(error) {
  return error?.code === 'EPERM' && String(error?.syscall || '').startsWith('spawn');
}

export function humanizeCodexFailure(rawMessage) {
  const message = String(rawMessage || '').trim();
  if (!message) {
    return 'Codex task failed';
  }

  if (/requires a newer version of Codex/i.test(message)) {
    const modelMatch = message.match(/'([^']+)'\s*model/i);
    const modelName = modelMatch ? modelMatch[1] : '该模型';
    return [
      `Codex CLI 版本过旧，无法使用 ${modelName}。`,
      '已尝试自动回退到本地支持的模型；如仍失败请运行 `npm i -g @openai/codex` 升级 CLI，',
      '或在客户端切换到本地 models_cache.json 中已存在的模型。',
      `原始信息：${message}`
    ].join(' ');
  }

  if (/already has an active writer/i.test(message)) {
    return [
      '这个会话正在桌面 Codex 里打开，桌面占着该线程的写入权限，手机后台写不进去。',
      '请在桌面结束/关闭该会话后重试，或新开一个会话继续。',
      `原始信息：${message}`
    ].join(' ');
  }

  if (/hit your usage limit|usage limit/i.test(message)) {
    const resetMatch = message.match(/try again at ([^.\n]+)/i);
    const resetHint = resetMatch ? `配额将在 ${resetMatch[1].trim()} 恢复。` : '请等待配额刷新或升级套餐后再试。';
    return `ChatGPT/Codex 使用配额已耗尽。${resetHint} 原始信息：${message}`;
  }

  if (/ENOENT.*\.cli-proxy-api/i.test(message)) {
    return [
      'CLIProxyAPI 配额查询失败：未找到 ~/.cli-proxy-api 目录。',
      '若你确实在使用 cliproxyapi 作为 model_provider，请先初始化 CLIProxyAPI；',
      '若不需要，可忽略该警告（不影响 Codex 主流程）。',
      `原始信息：${message}`
    ].join(' ');
  }

  if (/migration \d+ was previously applied but is missing/i.test(message)) {
    return [
      'Codex 本地 state DB 版本不兼容（检测到旧版迁移记录）。',
      '请删除 %USERPROFILE%\\.codex\\state_5.sqlite 让 Codex 重建，或升级到匹配的 Codex 版本。',
      `原始信息：${message}`
    ].join(' ');
  }

  if (/Failed to parse item:.*PID/i.test(message)) {
    return [
      'Codex 进程被中止时，taskkill 的中文输出被误当作流数据解析（GBK 乱码）。',
      '通常发生在用户主动取消任务后，可忽略。',
      `原始信息：${message}`
    ].join(' ');
  }

  return message;
}

function userFacingCodexError(error) {
  const baseMessage = String(error?.message || 'Codex task failed');
  if (process.platform === 'win32' && isSpawnPermissionError(error)) {
    return [
      'Codex 执行器启动被 Windows 拒绝（spawn EPERM）。',
      '通常是后台服务从受限环境启动导致的，请重启正式服务后再试。'
    ].join(' ');
  }
  return humanizeCodexFailure(baseMessage);
}

const CODEX_MODEL_CACHE_TTL_MS = 30_000;
let codexModelListCache = { fetchedAt: 0, models: [] };

async function listSupportedCodexModels() {
  const now = Date.now();
  if (now - codexModelListCache.fetchedAt < CODEX_MODEL_CACHE_TTL_MS && codexModelListCache.models.length) {
    return codexModelListCache.models;
  }
  try {
    const models = await readCodexModels(null);
    codexModelListCache = { fetchedAt: now, models };
    return models;
  } catch (error) {
    console.warn('[codex] Failed to read supported models cache:', error.message);
    return codexModelListCache.models;
  }
}

async function resolveSupportedCodexModel(requestedModel) {
  const supported = await listSupportedCodexModels();
  if (!supported.length) {
    return { model: requestedModel, fallback: null };
  }
  const normalized = String(requestedModel || '').trim();
  if (normalized && supported.some((entry) => entry.value === normalized)) {
    return { model: normalized, fallback: null };
  }
  const preferred =
    supported.find((entry) => /^gpt-5(-|$)/.test(entry.value)) ||
    supported.find((entry) => /^gpt-/.test(entry.value)) ||
    supported[0];
  return { model: preferred.value, fallback: { from: normalized || '(unset)', to: preferred.value, available: supported.map((m) => m.value) } };
}

function userFacingClaudeError(error, stderr = '') {
  const message = String(error?.message || stderr || 'Claude Code task failed').trim();
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/g, 'Bearer [hidden]')
    .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-[hidden]')
    .slice(0, 900);
}

function codexErrorDiagnostics(error) {
  return {
    message: error?.message || '',
    code: error?.code || '',
    errno: error?.errno || '',
    syscall: error?.syscall || '',
    path: error?.path || '',
    spawnargs: Array.isArray(error?.spawnargs) ? error.spawnargs : [],
    cwd: process.cwd(),
    execPath: process.execPath,
    pathLength: String(process.env.Path || process.env.PATH || '').length
  };
}

function flushOpenActivities(emit, state, { fallbackStatus = 'failed', detail = '' } = {}) {
  if (!state?.openActivities || !state.openActivities.size) return;
  for (const [, entry] of state.openActivities) {
    const finalDetail = detail || entry.detail || '';
    emitStatus(emit, {
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      kind: entry.kind,
      status: fallbackStatus,
      detail: finalDetail
    });
    emit({
      type: 'activity-update',
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      messageId: entry.messageId,
      kind: entry.kind,
      label: statusLabel(entry.kind, fallbackStatus),
      status: fallbackStatus,
      detail: finalDetail,
      command: entry.item?.command || '',
      output: entry.item?.aggregated_output || entry.item?.output || '',
      fileChanges: Array.isArray(entry.item?.changes) ? entry.item.changes : [],
      toolName: entry.item?.tool || entry.item?.name || '',
      error: fallbackStatus === 'failed' ? (finalDetail || '命令未返回结束事件') : '',
      timestamp: new Date().toISOString()
    });
  }
  state.openActivities.clear();
}

function emitActivity(emit, { sessionId, turnId, messageId, item, kind, status }) {
  const detail = detailFromItem(item);
  emit({
    type: 'activity-update',
    sessionId,
    turnId,
    messageId,
    kind,
    label: statusLabel(kind, status),
    status,
    detail,
    command: item?.command || '',
    output: item?.aggregated_output || item?.output || '',
    fileChanges: Array.isArray(item?.changes) ? item.changes : [],
    toolName: item?.tool || item?.name || '',
    error: item?.error?.message || item?.message || '',
    timestamp: new Date().toISOString()
  });
}

export function emitCodexEvent(event, sessionId, turnId, emit, state) {
  const threadId = event.thread_id || event.id || event.payload?.id;
  if (event.type === 'thread.started' && threadId) {
    emit({ type: 'thread-started', sessionId: threadId, turnId });
    return;
  }

  if (event.type === 'turn.started' || event.payload?.type === 'task_started') {
    emitStatus(emit, { sessionId, turnId, kind: 'reasoning', status: 'running', label: '正在思考' });
    return;
  }

  if (event.type === 'turn.completed') {
    flushOpenActivities(emit, state, { fallbackStatus: 'completed' });
    state.usage = event.usage || null;
    emitStatus(emit, { sessionId, turnId, kind: 'turn', status: 'completed', label: '任务已完成' });
    emit({ type: 'turn-complete', sessionId, turnId, usage: event.usage || null });
    return;
  }

  if (event.type === 'turn.failed') {
    const rawError = event.error?.message || event.error || 'Codex turn failed';
    const error = humanizeCodexFailure(rawError);
    state.failed = true;
    state.lastFailure = rawError;
    flushOpenActivities(emit, state, { fallbackStatus: 'failed', detail: error });
    emitStatus(emit, { sessionId, turnId, kind: 'turn', status: 'failed', label: '任务失败', detail: error });
    emit({ type: 'turn-failed', sessionId, turnId, error });
    emit({ type: 'chat-error', sessionId, turnId, error });
    console.error('[codex] Turn failed:', error);
    return;
  }

  if (event.type === 'error') {
    const rawError = event.message || 'Codex stream error';
    const error = humanizeCodexFailure(rawError);
    state.lastFailure = rawError;
    flushOpenActivities(emit, state, { fallbackStatus: 'failed', detail: error });
    emitStatus(emit, { sessionId, turnId, kind: 'error', status: 'failed', detail: error });
    emit({ type: 'chat-error', sessionId, turnId, error });
    console.error('[codex] Stream error:', error);
    return;
  }

  const item = eventItem(event);
  if (!item) {
    return;
  }
  const done = event.type === 'item.completed';
  const kind = item.type || 'item';
  const status = eventStatus(event, item);
  const messageId = item.id || `${turnId}-${kind}`;

  if (kind === 'agent_message' || item.phase === 'commentary') {
    const content = contentFromItem(item);
    if (content.trim()) {
      if (kind === 'agent_message') {
        state.hadAssistantText = true;
        emit({
          type: 'assistant-update',
          sessionId,
          turnId,
          messageId,
          role: 'assistant',
          kind: 'agent_message',
          phase: item.phase || 'final_answer',
          content,
          done: done || status === 'completed'
        });
      } else {
        emitStatus(emit, {
          sessionId,
          turnId,
          kind,
          status: 'running',
          label: compactStatusLabel(content)
        });
      }
    }
    return;
  }

  if (kind === 'message' && item.role === 'assistant') {
    const content = contentFromItem(item);
    if (content.trim()) {
      state.hadAssistantText = true;
      emitStatus(emit, { sessionId, turnId, kind, status: 'running', label: '正在回复' });
      emit({
        type: 'assistant-update',
        sessionId,
        turnId,
        messageId,
        role: 'assistant',
        kind,
        phase: item.phase || 'final_answer',
        content,
        done: done || status === 'completed'
      });
    }
    return;
  }

  if (kind === 'reasoning') {
    emitStatus(emit, {
      sessionId,
      turnId,
      kind,
      status,
      label: statusLabel(kind, status)
    });
    return;
  }

  if (kind === 'error') {
    const error = item.message || 'Codex item error';
    emitStatus(emit, { sessionId, turnId, kind, status: 'failed', detail: error });
    emit({
      type: 'chat-error',
      sessionId,
      turnId,
      error
    });
    console.error('[codex] Item error:', error);
    return;
  }

  if (
    kind === 'command_execution' ||
    kind === 'file_change' ||
    kind === 'mcp_tool_call' ||
    kind === 'web_search' ||
    kind === 'todo_list' ||
    kind === 'image_generation_call' ||
    kind === 'custom_tool_call' ||
    kind === 'function_call' ||
    kind === 'function_call_output' ||
    kind === 'exec_command_begin' ||
    kind === 'exec_command_end'
  ) {
    const normalizedKind =
      kind === 'exec_command_begin' || kind === 'exec_command_end' ? 'command_execution' : kind;
    const normalizedStatus = kind === 'function_call_output' ? 'completed' : status;
    if (!state.openActivities) state.openActivities = new Map();
    if (normalizedStatus === 'running') {
      state.openActivities.set(messageId, {
        sessionId,
        turnId,
        messageId,
        kind: normalizedKind,
        item,
        detail: detailFromItem(item)
      });
    } else {
      state.openActivities.delete(messageId);
    }
    emitStatus(emit, {
      sessionId,
      turnId,
      kind: normalizedKind,
      status: normalizedStatus,
      detail: detailFromItem(item)
    });
    emitActivity(emit, {
      sessionId,
      turnId,
      messageId,
      item,
      kind: normalizedKind,
      status: normalizedStatus
    });
    return;
  }

  const detail = detailFromItem(item);
  if (detail) {
    emitStatus(emit, { sessionId, turnId, kind, status, detail });
  }
}

function extractClaudeText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text || '')
    .filter(Boolean)
    .join('\n');
}

function claudeToolKind(toolName) {
  const name = String(toolName || '').toLowerCase();
  if (name === 'read' || name === 'notebookread') return 'file_read';
  if (name === 'edit' || name === 'multiedit' || name === 'write' || name === 'notebookedit') return 'file_change';
  if (name === 'bash' || name === 'powershell') return 'command_execution';
  if (name === 'glob' || name === 'grep') return 'web_search';
  if (name === 'webfetch' || name === 'websearch') return 'web_search';
  if (name === 'task' || name === 'agent') return 'function_call';
  if (name === 'todowrite') return 'todo_list';
  if (name?.startsWith('mcp__')) return 'mcp_tool_call';
  return 'function_call';
}

function claudeToolDetail(toolName, input) {
  if (!input || typeof input !== 'object') {
    return String(toolName || '');
  }
  const name = String(toolName || '').toLowerCase();
  if (name === 'read' || name === 'notebookread') {
    return input.file_path || input.notebook_path || '';
  }
  if (name === 'edit' || name === 'multiedit' || name === 'write' || name === 'notebookedit') {
    return input.file_path || input.notebook_path || '';
  }
  if (name === 'bash' || name === 'powershell') {
    return input.command || '';
  }
  if (name === 'glob') {
    return input.pattern || '';
  }
  if (name === 'grep') {
    return [input.pattern, input.path].filter(Boolean).join('  in  ');
  }
  if (name === 'webfetch') {
    return input.url || '';
  }
  if (name === 'websearch') {
    return input.query || '';
  }
  if (name === 'task' || name === 'agent') {
    return input.description || input.subagent_type || '';
  }
  try {
    const compact = JSON.stringify(input);
    return compact.length > 200 ? `${compact.slice(0, 200)}...` : compact;
  } catch {
    return '';
  }
}

function claudeStatusLabel(toolName, kind) {
  const name = String(toolName || '').toLowerCase();
  if (name === 'read' || name === 'notebookread') return '查看文件';
  if (name === 'edit' || name === 'multiedit') return '修改文件';
  if (name === 'write') return '写入文件';
  if (name === 'bash' || name === 'powershell') return '执行命令';
  if (name === 'glob') return '查找文件';
  if (name === 'grep') return '搜索内容';
  if (name === 'webfetch') return '抓取网页';
  if (name === 'websearch') return '搜索网络';
  if (name === 'task' || name === 'agent') return '调用子代理';
  if (name === 'todowrite') return '更新计划';
  if (name?.startsWith('mcp__')) return `MCP: ${toolName}`;
  return toolName || statusLabel(kind);
}

function claudeHooksEnabled() {
  return process.env.CODEXMOBILE_CLAUDE_USE_HOOKS === '1';
}

function mapClaudePermissionMode(permissionMode) {
  if (permissionMode === 'bypassPermissions') {
    // Full access: the PreToolUse hook stays installed (AskUserQuestion still
    // needs it in headless mode), but the approval route auto-allows every
    // non-question tool — see claude-approval-route.js. So action tools run
    // without a prompt; only AskUserQuestion choice forms still reach the PWA.
    return 'bypassPermissions';
  }
  if (permissionMode === 'acceptEdits') {
    return 'acceptEdits';
  }
  // Always run under acceptEdits regardless of the hook toggle.
  //
  // With CODEXMOBILE_CLAUDE_USE_HOOKS=1 we additionally install a
  // PreToolUse hook (see buildClaudeSettingsWithApprovalHook below) that
  // ONLY matches the dangerous tools (Bash etc.). For those tools the hook
  // asks the PWA; everything else (Read/Glob/Grep/...) keeps the acceptEdits
  // auto-allow so we don't prompt the user on every safe lookup.
  //
  // Returning 'default' here was wrong: 'default' makes Claude itself
  // prompt internally for every tool call, which in --print mode either
  // deadlocks or surfaces a flood of approval prompts before the hook
  // matcher even gets a chance to scope things down.
  return 'acceptEdits';
}

const CLAUDE_MODEL_ALIASES = new Set(['sonnet', 'opus', 'fable', 'haiku']);

// Locate the actual cwd Claude associates with a given session id by scanning
// ~/.claude/projects/<project-hash>/<session-id>.jsonl. Mobile session metadata
// can drift from Claude's on-disk layout (e.g. session created in project A
// but later listed under project B), which makes `--resume` fail with
// "No conversation found". Returns the original cwd recorded inside the
// session file, or null if the session is nowhere on disk.
async function findClaudeSessionCwd(sessionId) {
  if (!sessionId) return null;
  const claudeHome = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
  const projectsRoot = path.join(claudeHome, 'projects');
  let entries;
  try {
    entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    console.warn(`[claude] findClaudeSessionCwd readdir failed: ${error.message}`);
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(projectsRoot, entry.name, `${sessionId}.jsonl`);
    // Read only the head of the file. Session transcripts can grow into the
    // multi-MB range for long-running threads, but cwd is recorded on every
    // user/assistant line — line 1 or 2 in practice.
    let head;
    try {
      const handle = await fs.open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        head = buffer.slice(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[claude] findClaudeSessionCwd read failed for ${filePath}: ${error.message}`);
      }
      continue;
    }
    // Drop the last fragment in case the buffer cut a line in half.
    const segments = head.split(/\r?\n/);
    const lines = bytesReadBufferComplete(head) ? segments : segments.slice(0, -1);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed?.cwd && typeof parsed.cwd === 'string') {
          return parsed.cwd;
        }
      } catch {
        // Skip malformed lines and try the next one.
      }
    }
  }
  return null;
}

function bytesReadBufferComplete(head) {
  return head.endsWith('\n') || head.endsWith('\r');
}

// Path equality that mirrors the host filesystem semantics. On Windows, paths
// are case-insensitive, so `C:\Users\Foo` and `c:\users\foo` should match.
function samePath(a, b) {
  if (!a || !b) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function resolveClaudeModel(model) {
  const value = String(model || '').trim().toLowerCase();
  if (!value) return 'sonnet';
  if (CLAUDE_MODEL_ALIASES.has(value)) return value;
  if (/^claude-/i.test(model)) return model;
  // Non-Claude model value (e.g. 'gpt-5.5') — fall back to sonnet.
  return 'sonnet';
}

function claudeExecutable() {
  // Force UTF-8 codepage on Windows before launching claude.cmd. Default
  // CP936 (GBK) makes Windows-native error strings (e.g. ENOENT's
  // "找不到指定的文件") arrive as GBK bytes on stderr, which our utf-8
  // `chunk.toString()` then renders as mojibake in the log.
  if (process.platform === 'win32') {
    return 'chcp 65001 >NUL && claude.cmd';
  }
  return 'claude';
}

function claudeSpawnArgs(args) {
  return args;
}

// Serialize the *startup* window of every Claude CLI spawn from this server
// process. Claude reads/writes `~/.claude.json` non-atomically during init;
// two simultaneous spawns race and one truncates the file. We can't fix the
// upstream write pattern, and we can't coordinate with the user's own Claude
// Code session running outside this process, but at least we can stop our
// own sibling spawns from colliding with each other.
//
// The gate holds from `acquireClaudeSpawnGate()` until the returned release
// is called. Callers should release as soon as the child produces its first
// sign of life (first stdout chunk, close, or error) so cross-session mobile
// chats remain parallel for the long answering phase — only startup
// (~hundreds of ms) is serialized.
let claudeSpawnGateChain = Promise.resolve();

function acquireClaudeSpawnGate() {
  const wait = claudeSpawnGateChain;
  let release;
  claudeSpawnGateChain = new Promise((resolve) => {
    release = resolve;
  });
  return wait.then(() => release);
}

async function runClaudeTurn({ sessionId, draftSessionId, projectPath, message, model, reasoningEffort, permissionMode, selectedSkills = [], turnId: providedTurnId }, emit) {
  // If the session was created under a different cwd than the project we were
  // asked to use, Claude's `--resume` will fail with "No conversation found".
  // Look up the session's true cwd on disk and prefer it when present.
  const resumeCandidateId = sessionId || (draftSessionId && !String(draftSessionId).startsWith('draft-') ? draftSessionId : null);
  let effectiveProjectPath = projectPath;
  if (resumeCandidateId) {
    const recordedCwd = await findClaudeSessionCwd(resumeCandidateId).catch((error) => {
      console.warn(`[claude] findClaudeSessionCwd threw for ${resumeCandidateId}: ${error.message}`);
      return null;
    });
    console.log(`[claude] resume lookup session=${resumeCandidateId} requested=${projectPath} recorded=${recordedCwd}`);
    if (recordedCwd && !samePath(recordedCwd, projectPath)) {
      // The session was created under a different cwd than the requested
      // project. Verify the recorded cwd still exists before redirecting —
      // otherwise the spawn fails with a cryptic ENOENT on cwd that's harder
      // to diagnose than the original "No conversation found" from --resume.
      const recordedExists = await fs.stat(recordedCwd).then((st) => st.isDirectory()).catch(() => false);
      if (recordedExists) {
        console.log(`[claude] redirect cwd for resume session=${resumeCandidateId} requested=${projectPath} actual=${recordedCwd}`);
        effectiveProjectPath = recordedCwd;
      } else {
        console.warn(`[claude] resume session=${resumeCandidateId} recordedCwd missing, keeping requested cwd: ${recordedCwd}`);
      }
    }
  }
  const workingDirectory = await ensureAsciiWorkingDirectory(effectiveProjectPath);
  const normalizedReasoningEffort = normalizeReasoningEffort(reasoningEffort);
  const abortController = new AbortController();
  const turnId = providedTurnId || crypto.randomUUID();
  const currentSessionId = sessionId || (draftSessionId && !String(draftSessionId).startsWith('draft-') ? draftSessionId : crypto.randomUUID());
  const previousSessionId = draftSessionId || sessionId || null;
  const state = { hadAssistantText: false, failed: false, usage: null };
  const run = {
    process: null,
    abortController,
    turnId,
    sessionId: currentSessionId,
    previousSessionId,
    startedAt: new Date().toISOString(),
    status: 'running'
  };

  activeRuns.set(turnId, run);
  emit({
    type: 'chat-started',
    sessionId: currentSessionId,
    previousSessionId,
    turnId,
    projectPath,
    startedAt: new Date().toISOString()
  });
  if (!sessionId || previousSessionId !== currentSessionId) {
    emit({
      type: 'thread-started',
      sessionId: currentSessionId,
      previousSessionId,
      turnId,
      projectPath,
      startedAt: new Date().toISOString()
    });
  }
  emitStatus(emit, { sessionId: currentSessionId, turnId, kind: 'reasoning', status: 'running', label: '正在思考' });

  const skillsAppendix = await buildClaudeSkillsAppendix(selectedSkills);
  const args = [
    '-p',
    '--verbose',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--permission-mode',
    mapClaudePermissionMode(permissionMode),
    '--model',
    resolveClaudeModel(model)
  ];
  if (skillsAppendix) {
    args.push('--append-system-prompt', skillsAppendix);
  }
  // Install the PreToolUse hook only when the toggle is on AND the server
  // exposed its loopback URL. The hook script itself fails open if the env
  // is missing, but skipping the flag entirely is cleaner.
  //
  // We write the settings to a temp file rather than inlining the JSON on
  // the command line because spawning claude with `shell: true` on Windows
  // re-parses the arg list through cmd.exe, which eats the internal double
  // quotes and produces "Invalid JSON provided to --settings". A path arg
  // survives that round trip intact.
  const hookUrl = process.env.CODEXMOBILE_INTERNAL_HOOK_URL || '';
  let claudeSettingsTempPath = null;
  if (claudeHooksEnabled() && hookUrl) {
    claudeSettingsTempPath = path.join(
      os.tmpdir(),
      `codexmobile-claude-settings-${turnId}.json`
    );
    const composed = await buildClaudeSettingsWithApprovalHook(workingDirectory);
    await fs.writeFile(claudeSettingsTempPath, JSON.stringify(composed), 'utf8');
    args.push('--settings', claudeSettingsTempPath);
  }
  if (normalizedReasoningEffort) {
    args.push('--effort', normalizedReasoningEffort);
  }
  if (sessionId || (draftSessionId && !String(draftSessionId).startsWith('draft-'))) {
    args.push('--resume', currentSessionId);
  } else {
    args.push('--session-id', currentSessionId);
  }
  const promptInput = message;

  // Retry once when Claude CLI exits with a `~/.claude.json` parse error.
  // Two concurrent Claude processes (this server's sibling spawn, or the
  // user's own Claude Code session) can race on the non-atomic config-file
  // write and leave it empty/partial. Claude rewrites a fresh default on the
  // failure path, so an immediate retry typically succeeds. Skip the retry
  // when we already streamed assistant text (would double-emit) or when the
  // user aborted.
  const MAX_CLAUDE_ATTEMPTS = 2;
  let attemptNumber = 0;
  let stderr = '';
  let exitCode = null;

  try {
   while (true) {
    attemptNumber++;
    stderr = '';
    exitCode = null;
    let shouldRetry = false;

    let releaseSpawnGate = null;
    try {
    const claudeEnv = { ...process.env };
    if (claudeHooksEnabled() && hookUrl) {
      claudeEnv.CODEXMOBILE_HOOK_URL = hookUrl;
      claudeEnv.CODEXMOBILE_HOOK_SECRET = getClaudeHookSecret();
      claudeEnv.CODEXMOBILE_TURN_ID = turnId;
      claudeEnv.CODEXMOBILE_SESSION_ID = currentSessionId;
    }
    releaseSpawnGate = await acquireClaudeSpawnGate();
    const child = spawn(claudeExecutable(), claudeSpawnArgs(args), {
      cwd: workingDirectory,
      env: claudeEnv,
      windowsHide: true,
      shell: process.platform === 'win32',
      signal: abortController.signal
    });
    // Release the gate after the child shows it has finished startup. First
    // stdout chunk is the cleanest signal (claude has emitted its init JSON);
    // close/error covers the failure paths; a 2s timeout caps how long we
    // ever hold the gate even if claude is unusually slow to produce stdout.
    const releaseGateOnce = () => {
      if (releaseSpawnGate) {
        const fn = releaseSpawnGate;
        releaseSpawnGate = null;
        fn();
      }
    };
    const gateTimeout = setTimeout(releaseGateOnce, 2000);
    const clearAndRelease = () => { clearTimeout(gateTimeout); releaseGateOnce(); };
    child.stdout.once('data', clearAndRelease);
    child.once('close', clearAndRelease);
    child.once('error', clearAndRelease);
    child.on('error', (err) => {
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        return;
      }
      console.error('[claude] child error:', err.message || err);
    });
    run.process = child;
    const exitPromise = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.end(promptInput, 'utf8');

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const partialStreamState = createClaudePartialStreamState();
    for await (const line of rl) {
      if (run.status === 'aborted') {
        break;
      }
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) {
        continue;
      }
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (event.type === 'stream_event') {
        processClaudePartialStreamEvent(event, partialStreamState, emit, {
          sessionId: currentSessionId,
          previousSessionId,
          turnId
        });
        if (partialStreamState.hadPartialText) {
          state.hadAssistantText = true;
        }
        continue;
      }

      if (event.type === 'assistant') {
        const parts = Array.isArray(event.message?.content) ? event.message.content : [];
        const content = extractClaudeText(event.message?.content);
        // A Claude turn streams several assistant messages (narration → tool →
        // narration → … → final answer), and the CLI emits the narration text
        // and the tool_use as *separate* assistant events. `done` here means
        // "this assistant message is complete", which the client wrongly reads
        // as "the turn is complete" — running completeActivityMessagesForTurn
        // and stamping the live activity card "已完成", so "正在处理" drops out
        // mid-turn. Never claim turn-completion from a message-level signal:
        // emit assistant text with done:false and let chat-complete be the sole
        // turn terminal (it removes the activity card via markTurnCompleted).
        if (content.trim()) {
          state.hadAssistantText = true;
          emit({
            type: 'assistant-update',
            sessionId: currentSessionId,
            previousSessionId,
            turnId,
            messageId: claudeAssistantMessageId(event),
            role: 'assistant',
            content,
            done: false,
            timestamp: new Date().toISOString()
          });
        } else if (parts.some((part) => part?.type === 'thinking')) {
          emitStatus(emit, { sessionId: currentSessionId, turnId, kind: 'reasoning', status: 'running', label: '正在思考' });
        }
        for (const part of parts) {
          if (part?.type !== 'tool_use') continue;
          const kind = claudeToolKind(part.name);
          const detail = claudeToolDetail(part.name, part.input);
          const label = claudeStatusLabel(part.name, kind);
          emitStatus(emit, { sessionId: currentSessionId, turnId, kind, status: 'running', label, detail });
          emit({
            type: 'activity-update',
            sessionId: currentSessionId,
            turnId,
            messageId: part.id || event.uuid || event.message?.id,
            kind,
            label,
            status: 'running',
            detail,
            command: part.input?.command || '',
            output: '',
            fileChanges: [],
            toolName: part.name || '',
            error: '',
            timestamp: new Date().toISOString()
          });
        }
      } else if (event.type === 'user' && Array.isArray(event.message?.content)) {
        for (const part of event.message.content) {
          if (part?.type !== 'tool_result') continue;
          const isError = part.is_error === true;
          const text = Array.isArray(part.content)
            ? part.content.filter((c) => c?.type === 'text').map((c) => c.text || '').join('\n')
            : (typeof part.content === 'string' ? part.content : '');
          const trimmed = text.length > 400 ? `${text.slice(0, 400)}...` : text;
          emit({
            type: 'activity-update',
            sessionId: currentSessionId,
            turnId,
            messageId: part.tool_use_id || event.uuid,
            kind: 'function_call_output',
            label: isError ? '工具调用失败' : '工具调用完成',
            status: isError ? 'failed' : 'completed',
            detail: trimmed,
            command: '',
            output: trimmed,
            fileChanges: [],
            toolName: '',
            error: isError ? trimmed : '',
            timestamp: new Date().toISOString()
          });
        }
      } else if (event.type === 'result') {
        state.usage = event.usage || null;
        if (event.is_error) {
          state.failed = true;
          let errorMessage = event.result || event.subtype || 'Claude Code 任务失败';
          // Surface a friendlier message when Claude can't locate the session.
          // Even with the resume-cwd lookup this can still happen if the
          // session file was deleted between lookup and spawn, or if Claude's
          // hash function has drifted from what we expect.
          if (/No conversation found with session ID/i.test(stderr)) {
            errorMessage = '会话在 Claude 本地存储中找不到，可能已被清理。请新建对话继续。';
          }
          console.error('[claude] Result error:', {
            subtype: event.subtype || '',
            durationMs: event.duration_ms || event.duration_api_ms || 0,
            numTurns: event.num_turns || 0,
            result: errorMessage,
            stderr: stderr.slice(-2000),
            args: args.slice(0, 12)
          });
          emit({
            type: 'chat-error',
            sessionId: currentSessionId,
            previousSessionId,
            turnId,
            error: errorMessage
          });
        }
      } else if (event.type === 'system' && event.subtype === 'init') {
        emitStatus(emit, {
          sessionId: currentSessionId,
          turnId,
          kind: 'reasoning',
          status: 'running',
          label: `Claude Code ${event.model || model || 'sonnet'}`
        });
      }
    }

    exitCode = await exitPromise;

    if (run.status === 'aborted') {
      emit({ type: 'chat-aborted', sessionId: currentSessionId, previousSessionId, turnId });
    } else if (exitCode !== 0 && !state.failed) {
      throw new Error(stderr || `Claude Code exited with code ${exitCode}`);
    } else if (!state.failed) {
      emit({
        type: 'chat-complete',
        sessionId: currentSessionId,
        previousSessionId,
        turnId,
        usage: state.usage,
        hadAssistantText: state.hadAssistantText,
        completedAt: new Date().toISOString()
      });
    }
    } catch (error) {
      // Safety net: if spawn threw before our gate-release handlers got
      // wired up, drop the gate now or the next claude spawn deadlocks.
      if (releaseSpawnGate) {
        const fn = releaseSpawnGate;
        releaseSpawnGate = null;
        fn();
      }
      const wasAborted =
        error?.name === 'AbortError' ||
        String(error?.message || '').toLowerCase().includes('aborted') ||
        activeRuns.get(turnId)?.status === 'aborted';
      const isClaudeConfigRace =
        !wasAborted
        && attemptNumber < MAX_CLAUDE_ATTEMPTS
        && !state.hadAssistantText
        && /Configuration error in .+\.claude\.json/i.test(stderr);
      if (isClaudeConfigRace) {
        console.warn(`[claude] .claude.json race on attempt ${attemptNumber}, retrying once`);
        shouldRetry = true;
      } else {
        const userError = userFacingClaudeError(error, stderr);
        emit({
          type: wasAborted ? 'chat-aborted' : 'chat-error',
          sessionId: currentSessionId,
          previousSessionId,
          turnId,
          error: wasAborted ? null : userError
        });
        if (!wasAborted) {
          console.error('[claude] Chat error:', userError);
          emitStatus(emit, {
            sessionId: currentSessionId,
            turnId,
            kind: 'turn',
            status: 'failed',
            label: '任务失败',
            detail: userError
          });
        }
      }
    }

    if (shouldRetry) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }
    break;
   }
  } finally {
    if (claudeSettingsTempPath) {
      fs.unlink(claudeSettingsTempPath).catch(() => null);
    }
    if (activeRuns.has(turnId)) {
      const activeRun = activeRuns.get(turnId);
      activeRun.status = activeRun.status === 'aborted' ? 'aborted' : 'completed';
      activeRuns.delete(turnId);
    }
  }

  return currentSessionId;
}

export async function runCodexTurn({ sessionId, draftSessionId, projectPath, message, model, reasoningEffort, permissionMode, selectedSkills, turnId: providedTurnId, ...rest }, emit) {
  if (isClaudeMode()) {
    return runClaudeTurn({ sessionId, draftSessionId, projectPath, message, model, reasoningEffort, permissionMode, selectedSkills, turnId: providedTurnId }, emit);
  }

  if (process.env.CODEXMOBILE_CODEX_USE_APP_SERVER === '1') {
    // Dynamic import to break the cycle: the app-server runner imports
    // emitCodexEvent + humanizeCodexFailure from this file.
    const { runCodexTurnViaAppServer } = await import('./codex-app-server-runner.js');
    return runCodexTurnViaAppServer({
      sessionId,
      draftSessionId,
      projectPath,
      message,
      model,
      reasoningEffort,
      permissionMode,
      selectedSkills,
      attachments: rest?.attachments,
      turnId: providedTurnId
    }, emit);
  }

  const { Codex } = await import('@openai/codex-sdk');
  const workingDirectory = await ensureAsciiWorkingDirectory(projectPath);
  const { sandboxMode, approvalPolicy } = mapPermissionMode(permissionMode);
  const feishuSkillKeys = detectFeishuSkillKeys(message);
  const normalizedReasoningEffort = normalizeReasoningEffort(reasoningEffort);
  const modelReasoningEffort =
    feishuSkillKeys.length && normalizedReasoningEffort === 'xhigh' ? 'low' : normalizedReasoningEffort;
  const larkCliContext = await buildCodexLarkCliContext(message).catch((error) => {
    console.warn('[lark-cli] Codex context disabled:', error.message);
    return { enabled: false, env: { ...process.env }, instruction: '' };
  });
  const abortController = new AbortController();
  const turnId = providedTurnId || crypto.randomUUID();
  const state = { hadAssistantText: false, failed: false, usage: null };
  const run = {
    thread: null,
    abortController,
    turnId,
    sessionId: sessionId || draftSessionId || null,
    previousSessionId: draftSessionId || sessionId || null,
    startedAt: new Date().toISOString(),
    status: 'running'
  };

  let currentSessionId = sessionId || null;
  let previousSessionId = draftSessionId || sessionId || null;
  let thread = null;

  try {
    if (larkCliContext.enabled && larkCliContext.env) {
      larkCliContext.env.CODEXMOBILE_TURN_ID = turnId;
      larkCliContext.env.CODEXMOBILE_SESSION_ID = sessionId || draftSessionId || '';
    }
    const baseEnv = larkCliContext.env || { ...process.env };
    const cliproxyApiKey = process.env.CLIPROXYAPI_API_KEY;
    const cliproxyManagementUrl = process.env.CODEXMOBILE_CLIPROXY_MANAGEMENT_URL || 'http://127.0.0.1:8317';
    const cliproxyBaseUrl = `${cliproxyManagementUrl}/v1`;
    const useClipProxy = Boolean(cliproxyApiKey);
    const codex = new Codex({
      env: baseEnv,
      ...(useClipProxy ? { baseUrl: cliproxyBaseUrl, apiKey: cliproxyApiKey } : {})
    });
    const { model: resolvedModel, fallback: modelFallback } = await resolveSupportedCodexModel(model);
    if (modelFallback) {
      const detail = `Codex CLI 不支持 ${modelFallback.from}，已自动回退到 ${modelFallback.to}（本地可用：${modelFallback.available.join(', ') || '无'}）。请升级 Codex CLI 以使用更新的模型。`;
      console.warn('[codex] Model fallback:', detail);
      emitStatus(emit, { sessionId: sessionId || draftSessionId || '', turnId, kind: 'reasoning', status: 'running', label: '模型回退', detail });
    }
    const threadOptions = {
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      model: resolvedModel,
      modelReasoningEffort,
      ...(larkCliContext.enabled ? { networkAccessEnabled: true } : {})
    };

    thread = sessionId ? codex.resumeThread(sessionId, threadOptions) : codex.startThread(threadOptions);
    currentSessionId = thread.id || sessionId || `codex-${Date.now()}`;
    run.thread = thread;
    run.sessionId = currentSessionId;
    activeRuns.set(turnId, run);

    emit({
      type: 'chat-started',
      sessionId: currentSessionId,
      previousSessionId,
      turnId,
      projectPath,
      startedAt: new Date().toISOString()
    });
    emitStatus(emit, { sessionId: currentSessionId, turnId, kind: 'reasoning', status: 'running', label: '正在思考' });

    const codexInput = [message, larkCliContext.enabled ? larkCliContext.instruction : '']
      .filter(Boolean)
      .join('\n\n');
    const streamedTurn = await thread.runStreamed(codexInput, { signal: abortController.signal });
    for await (const event of streamedTurn.events) {
      const threadId = event.thread_id || event.id || event.payload?.id;
      if (event.type === 'thread.started' && threadId) {
        const fromSessionId = previousSessionId || currentSessionId;
        if (threadId !== currentSessionId) {
          currentSessionId = threadId;
          run.sessionId = threadId;
        }
        previousSessionId = fromSessionId;
        run.previousSessionId = fromSessionId;
        emit({
          type: 'thread-started',
          sessionId: threadId,
          previousSessionId: fromSessionId,
          turnId,
          projectPath,
          startedAt: new Date().toISOString()
        });
        emitStatus(emit, { sessionId: threadId, turnId, kind: 'reasoning', status: 'running', label: '正在思考' });
        continue;
      }
      if (run.status === 'aborted') {
        break;
      }
      emitCodexEvent(event, currentSessionId, turnId, emit, state);
    }

    if (!state.failed) {
      flushOpenActivities(emit, state, { fallbackStatus: 'completed' });
      emit({
        type: 'chat-complete',
        sessionId: currentSessionId,
        previousSessionId,
        turnId,
        usage: state.usage,
        hadAssistantText: state.hadAssistantText,
        completedAt: new Date().toISOString()
      });
    }
  } catch (error) {
    const wasAborted =
      error?.name === 'AbortError' ||
      String(error?.message || '').toLowerCase().includes('aborted') ||
      activeRuns.get(turnId)?.status === 'aborted';
    const userError = userFacingCodexError(error);
    flushOpenActivities(emit, state, { fallbackStatus: wasAborted ? 'completed' : 'failed', detail: wasAborted ? '' : userError });

    emit({
      type: wasAborted ? 'chat-aborted' : 'chat-error',
      sessionId: currentSessionId,
      turnId,
      error: wasAborted ? null : userError
    });
    if (!wasAborted) {
      console.error('[codex] Chat error:', userError);
      console.error('[codex] Chat error diagnostics:', codexErrorDiagnostics(error));
      emitStatus(emit, {
        sessionId: currentSessionId,
        turnId,
        kind: 'turn',
        status: 'failed',
        label: '任务失败',
        detail: userError
      });
    }
  } finally {
    flushOpenActivities(emit, state, { fallbackStatus: 'completed' });
    if (activeRuns.has(turnId)) {
      const activeRun = activeRuns.get(turnId);
      activeRun.status = activeRun.status === 'aborted' ? 'aborted' : 'completed';
      activeRuns.delete(turnId);
    }
  }

  return currentSessionId;
}

function runMatchesIdentifier(run, identifier) {
  return (
    Boolean(identifier) &&
    (run.turnId === identifier || run.sessionId === identifier || run.previousSessionId === identifier)
  );
}

function terminateRunProcess(run) {
  if (!run?.process || run.process.killed) {
    return;
  }
  if (process.platform === 'win32' && run.process.pid) {
    spawn('taskkill.exe', ['/pid', String(run.process.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore'
    }).on('error', () => null);
    return;
  }
  run.process.kill('SIGTERM');
}

export function abortCodexTurn(identifier) {
  const id = String(identifier || '').trim();
  const runs = [...activeRuns.values()].filter(
    (run) => run.status === 'running' && runMatchesIdentifier(run, id)
  );
  if (!runs.length) {
    return false;
  }
  for (const run of runs) {
    run.status = 'aborted';
    try {
      terminateRunProcess(run);
    } catch (error) {
      console.warn('[abort] terminateRunProcess failed:', error?.message || error);
    }
    try {
      run.abortController.abort();
    } catch (error) {
      console.warn('[abort] abortController.abort failed:', error?.message || error);
    }
  }
  return true;
}

export function getActiveRuns() {
  return [...activeRuns.values()]
    .filter((run) => run.status === 'running')
    .map((run) => ({
      sessionId: run.sessionId,
      previousSessionId: run.previousSessionId,
      startedAt: run.startedAt,
      status: run.status,
      turnId: run.turnId
    }));
}
