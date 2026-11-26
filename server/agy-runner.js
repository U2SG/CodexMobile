import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { DEFAULT_AGY_MODEL } from './agy-config.js';
import { shellSpawnArgs } from './shell-command.js';

const MODEL_EFFORT_SUFFIX_PATTERN = /-(?:low|medium|high|xhigh|max)$/i;

const HOST_AGY_ENV_KEYS = [
  'ANTIGRAVITY_LS_ADDRESS',
  'ANTIGRAVITY_CSRF_TOKEN',
  'ANTIGRAVITY_CONVERSATION_ID',
  'ANTIGRAVITY_PROJECT_ID'
];

export function agyExecutable(env = process.env) {
  const configured = String(env.CODEXMOBILE_AGY_BIN || env.AGY_BIN || '').trim();
  if (configured) {
    return configured;
  }
  if (process.platform !== 'win32') {
    const localBin = path.join(os.homedir(), '.local', 'bin', 'agy');
    if (fsSync.existsSync(localBin)) {
      return localBin;
    }
  }
  return 'agy';
}

export function cleanAgyEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of HOST_AGY_ENV_KEYS) {
    delete env[key];
  }
  if (process.platform !== 'win32') {
    const localDir = path.join(os.homedir(), '.local', 'bin');
    const currentPath = env.PATH || '';
    if (!currentPath.split(':').includes(localDir)) {
      env.PATH = currentPath ? `${localDir}:${currentPath}` : localDir;
    }
  }
  return env;
}

export function mapAgyPermissionArgs(permissionMode) {
  const mode = String(permissionMode || '').trim();
  if (mode === 'bypassPermissions') {
    return ['--dangerously-skip-permissions'];
  }
  if (mode === 'plan') {
    return ['--mode', 'plan'];
  }
  if (mode === 'acceptEdits') {
    return ['--mode', 'accept-edits'];
  }
  // Headless print mode has no TTY for interactive review prompts; default to
  // accept-edits so file edits proceed while keeping dangerous shell commands
  // governed by agy's policy.
  return ['--mode', 'accept-edits'];
}

export function resolveAgyModel(requestedModel) {
  const value = String(requestedModel || '').trim();
  return value || String(process.env.CODEXMOBILE_AGY_MODEL || DEFAULT_AGY_MODEL).trim() || DEFAULT_AGY_MODEL;
}

export function normalizeAgyReasoningEffort(reasoningEffort) {
  const value = String(reasoningEffort || '').trim().toLowerCase();
  if (value === 'minimal') return 'low';
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(value) ? value : null;
}

export function buildAgyArgs({
  prompt,
  model,
  reasoningEffort,
  permissionMode,
  resumeSessionId = null
} = {}) {
  const resolvedModel = resolveAgyModel(model);
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    ...mapAgyPermissionArgs(permissionMode),
    '--model',
    resolvedModel
  ];
  const normalizedEffort = normalizeAgyReasoningEffort(reasoningEffort);
  if (normalizedEffort && !MODEL_EFFORT_SUFFIX_PATTERN.test(resolvedModel)) {
    args.push('--effort', normalizedEffort);
  }
  if (resumeSessionId) {
    args.push('--resume', String(resumeSessionId));
  }
  args.push('--', String(prompt || ''));
  return args;
}

function stepActivityMeta(stepType, state) {
  const normalized = String(stepType || '').trim().toLowerCase();
  const status = state === 'DONE'
    ? 'completed'
    : (state === 'ERROR' || state === 'FAILED' ? 'failed' : 'running');

  if (normalized.includes('command') || normalized.includes('terminal') || normalized.includes('shell')) {
    return {
      kind: 'command_execution',
      status,
      label: status === 'completed' ? '命令已完成' : status === 'failed' ? '命令失败' : '正在执行命令'
    };
  }
  if (normalized.includes('write') || normalized.includes('edit') || normalized.includes('replace') || normalized.includes('file')) {
    return {
      kind: 'file_change',
      status,
      label: status === 'completed' ? '文件已修改' : status === 'failed' ? '文件修改失败' : '正在修改文件'
    };
  }
  if (normalized.includes('search') || normalized.includes('web') || normalized.includes('grep') || normalized.includes('find')) {
    return {
      kind: 'web_search',
      status,
      label: status === 'completed' ? '搜索完成' : status === 'failed' ? '搜索失败' : '正在搜索'
    };
  }
  if (normalized.includes('think') || normalized.includes('plan') || normalized.includes('reason')) {
    return {
      kind: 'reasoning',
      status,
      label: status === 'completed' ? '思考完成' : '正在思考'
    };
  }
  return {
    kind: 'function_call',
    status,
    label: status === 'completed' ? '工具调用完成' : status === 'failed' ? '工具调用失败' : '正在调用工具'
  };
}

export function createAgyStreamProcessor({
  emit,
  emitStatus,
  state,
  getSessionId,
  onConversationId,
  previousSessionId,
  turnId,
  requestedModel
}) {
  const textByStep = new Map();

  return function handleEvent(event) {
    if (!event || typeof event !== 'object') return;

    const eventConversationId =
      event.conversation_id ||
      event.step_update?.conversation_id ||
      event.result?.conversation_id ||
      null;
    if (eventConversationId && typeof onConversationId === 'function') {
      onConversationId(String(eventConversationId));
    }

    const sessionId = getSessionId();

    if (event.event === 'init') {
      const modelName = String(event.init?.model || requestedModel || '').trim();
      emitStatus(emit, {
        sessionId,
        turnId,
        kind: 'reasoning',
        status: 'running',
        label: modelName ? `AGY ${modelName}` : 'AGY 正在处理'
      });
      return;
    }

    if (event.event === 'step_update' && event.step_update) {
      const update = event.step_update;
      if (update.usage) {
        state.usage = update.usage;
      }

      if (update.step_type === 'user_input') {
        return;
      }

      if (update.step_type === 'agent_response') {
        const stepKey = Number.isInteger(update.step_index) ? update.step_index : 0;
        const delta = typeof update.text_delta === 'string' ? update.text_delta : '';
        const prev = textByStep.get(stepKey) || '';
        const next = prev + delta;
        textByStep.set(stepKey, next);

        if (next.trim()) {
          state.hadAssistantText = true;
          emit({
            type: 'assistant-update',
            sessionId,
            previousSessionId,
            turnId,
            messageId: `agy-${sessionId || turnId}-${stepKey}`,
            role: 'assistant',
            content: next,
            done: false,
            timestamp: new Date().toISOString()
          });
        }
        return;
      }

      const meta = stepActivityMeta(update.step_type, update.state);
      const detail = String(update.tool_name || update.summary || update.detail || update.step_type || '').trim();
      emitStatus(emit, {
        sessionId,
        turnId,
        kind: meta.kind,
        status: meta.status,
        label: meta.label,
        detail
      });
      emit({
        type: 'activity-update',
        sessionId,
        turnId,
        messageId: `agy-step-${sessionId || turnId}-${update.step_index ?? 'x'}`,
        kind: meta.kind,
        label: meta.label,
        status: meta.status,
        detail,
        command: '',
        output: '',
        fileChanges: [],
        toolName: String(update.tool_name || update.step_type || ''),
        error: meta.status === 'failed' ? String(update.error || detail || 'AGY step failed') : '',
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (event.event === 'result' && event.result) {
      const result = event.result;
      if (result.usage) {
        state.usage = result.usage;
      }
      const status = String(result.status || '').toUpperCase();
      const isFailure = (status && status !== 'SUCCESS') || Boolean(result.error);
      if (isFailure) {
        state.failed = true;
        const errorMessage = String(result.error || result.message || `AGY 任务失败（${status || 'ERROR'}）`).trim();
        emit({
          type: 'chat-error',
          sessionId,
          previousSessionId,
          turnId,
          error: errorMessage
        });
        return;
      }
      if (!state.hadAssistantText && typeof result.response === 'string' && result.response.trim()) {
        state.hadAssistantText = true;
        emit({
          type: 'assistant-update',
          sessionId,
          previousSessionId,
          turnId,
          messageId: `agy-${sessionId || turnId}-final`,
          role: 'assistant',
          content: result.response,
          done: false,
          timestamp: new Date().toISOString()
        });
      }
    }
  };
}

function userFacingAgyError(error, stderr = '') {
  const raw = String(stderr || error?.message || 'AGY 任务失败').trim();
  if (/ENOENT/i.test(String(error?.code || raw))) {
    return '未找到 agy 可执行文件，请确认 Antigravity CLI 已安装并在 PATH 中（默认 ~/.local/bin/agy）。';
  }
  return raw || 'AGY 任务失败';
}

export async function runAgyTurn(
  {
    sessionId,
    draftSessionId,
    projectPath,
    message,
    model,
    reasoningEffort,
    permissionMode,
    turnId: providedTurnId
  },
  emit,
  { activeRuns, emitStatus }
) {
  const abortController = new AbortController();
  const turnId = providedTurnId || crypto.randomUUID();
  const resumingSession = Boolean(sessionId && !String(sessionId).startsWith('draft-'));
  let currentSessionId = resumingSession ? sessionId : (draftSessionId || `agy-pending-${turnId}`);
  let previousSessionId = draftSessionId || sessionId || null;
  let boundRealConversation = resumingSession;

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
  emitStatus(emit, {
    sessionId: currentSessionId,
    turnId,
    kind: 'reasoning',
    status: 'running',
    label: '正在思考'
  });

  let stderr = '';
  try {
    const requestedModel = resolveAgyModel(model);
    const args = buildAgyArgs({
      prompt: message,
      model: requestedModel,
      reasoningEffort,
      permissionMode,
      resumeSessionId: resumingSession ? sessionId : null
    });
    const launch = shellSpawnArgs(agyExecutable(), args);
    const child = spawn(launch.command, launch.args, {
      cwd: projectPath,
      env: cleanAgyEnv(process.env),
      windowsHide: true,
      shell: launch.shell,
      signal: abortController.signal
    });
    run.process = child;

    child.on('error', (err) => {
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        return;
      }
      console.error('[agy] child error:', err.message || err);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    child.stdin.end();

    const exitPromise = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    const handleEvent = createAgyStreamProcessor({
      emit,
      emitStatus,
      state,
      getSessionId: () => currentSessionId,
      onConversationId: (realId) => {
        if (!realId || (boundRealConversation && currentSessionId === realId)) {
          return;
        }
        const fromSessionId = previousSessionId || currentSessionId;
        currentSessionId = realId;
        previousSessionId = fromSessionId;
        boundRealConversation = true;
        run.sessionId = realId;
        run.previousSessionId = fromSessionId;
        emit({
          type: 'thread-started',
          sessionId: realId,
          previousSessionId: fromSessionId,
          turnId,
          projectPath,
          startedAt: new Date().toISOString()
        });
      },
      previousSessionId,
      turnId,
      requestedModel
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      if (run.status === 'aborted') {
        break;
      }
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) {
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      handleEvent(parsed);
    }

    const exitCode = await exitPromise;
    if (run.status === 'aborted') {
      emit({ type: 'chat-aborted', sessionId: currentSessionId, previousSessionId, turnId });
    } else if (exitCode !== 0 && !state.failed) {
      throw new Error(stderr || `AGY exited with code ${exitCode}`);
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
    const wasAborted =
      error?.name === 'AbortError' ||
      error?.code === 'ABORT_ERR' ||
      String(error?.message || '').toLowerCase().includes('aborted') ||
      activeRuns.get(turnId)?.status === 'aborted';
    const userError = userFacingAgyError(error, stderr);
    emit({
      type: wasAborted ? 'chat-aborted' : 'chat-error',
      sessionId: currentSessionId,
      previousSessionId,
      turnId,
      error: wasAborted ? null : userError
    });
    if (!wasAborted) {
      console.error('[agy] Chat error:', userError);
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
    if (activeRuns.has(turnId)) {
      const activeRun = activeRuns.get(turnId);
      activeRun.status = activeRun.status === 'aborted' ? 'aborted' : 'completed';
      activeRuns.delete(turnId);
    }
  }

  return currentSessionId;
}
