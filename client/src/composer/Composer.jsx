// Composer — input area + attachment tray + queued-drafts panel + voice
// recording + slash-command / @file picker + permission / model / send-mode
// menus + image-intent confirmation strip. The biggest single component in
// the chat shell.
//
// Extracted from App.jsx (Batch G R24). Permission / reasoning option
// dictionaries, label helpers, byte / model-name formatters, and the
// one-shot voice recording constants moved with it because no other
// caller uses them.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  Headphones,
  Image,
  Loader2,
  Mic,
  MessageSquare,
  MessageSquarePlus,
  Paperclip,
  Plus,
  Settings2,
  Square,
  Trash2,
  X
} from 'lucide-react';
import { apiFetch, getToken } from '../api.js';
import { agentMeta, isClaudeProvider } from '../agent-meta.js';
import { canGuideCurrentTask as canGuideCurrentTaskForSend } from '../runtime-capabilities.js';
import {
  SLASH_COMMANDS,
  detectComposerToken,
  filteredSkillsForToken,
  filteredSlashCommands,
  mergeSlashCommandsForClaude,
  replaceComposerToken
} from '../composer-shortcuts.js';
import {
  filteredQuickPrompts,
  getStoredPrompts,
  pinPrompt,
  recordPromptUse,
  unpinPrompt
} from '../quick-prompts.js';
import { isSkillSelected, toggleSkill } from '../skills/skill-selection.js';
import { attachmentPreviewUrl, isImageAttachment } from './attachment-preview.js';
import { isDraftSession, localFilePreviewPath } from '../app/session-utils.js';

const VOICE_MAX_RECORDING_MS = 90 * 1000;
const VOICE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const VOICE_MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];

const PERMISSION_OPTIONS = [
  { value: 'default', label: '默认权限' },
  { value: 'acceptEdits', label: '自动接受编辑' },
  { value: 'bypassPermissions', label: '完全访问', danger: true }
];

const REASONING_OPTIONS = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' }
];

function formatBytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 102.4) / 10} KB`;
  }
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

function shortModelName(model) {
  // No hardcoded provider-specific fallback — caller is responsible for
  // deciding what to display when the model is unknown. Returning a Codex
  // flavor like '5.5' here leaks a wrong default onto the Claude route on
  // the brief render before /api/status arrives.
  if (!model) {
    return '--';
  }
  if (/claude|sonnet|opus|haiku/i.test(model)) {
    return model
      .replace(/^claude\s+/i, '')
      .replace(/^claude-/i, '')
      .replace(/-\d{8}$/i, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  return model
    .replace(/^gpt-/i, '')
    .replace(/-codex.*$/i, '')
    .replace(/-mini$/i, ' mini');
}

function permissionLabel(value) {
  return PERMISSION_OPTIONS.find((option) => option.value === value)?.label || '默认权限';
}

function reasoningLabel(value) {
  return REASONING_OPTIONS.find((option) => option.value === value)?.label || '超高';
}

export function Composer({
  input,
  setInput,
  onSubmit,
  running,
  onAbort,
  onSteer,
  models,
  selectedModel,
  onSelectModel,
  selectedReasoningEffort,
  onSelectReasoningEffort,
  permissionMode,
  onSelectPermission,
  attachments,
  onUploadFiles,
  onRemoveAttachment,
  uploading,
  onVoiceSubmit,
  onOpenVoiceDialog,
  voiceDialogActive,
  selectedProject,
  selectedSession,
  onOpenStatus,
  onCompact,
  connectionState,
  desktopBridge,
  status,
  queueDrafts = [],
  onRemoveQueueDraft,
  onRestoreQueueDraft,
  onSteerQueueDraft,
  imageIntentConfirmation,
  onResolveImageIntent,
  availableSkills = [],
  selectedSkills = [],
  onChangeSelectedSkills = () => {},
  onOpenSkillPicker = () => {},
  forceImageActive = false,
  onToggleForceImage = () => {},
  planModeActive = false,
  onTogglePlanMode = () => {},
  agentId = 'codex',
  claudeSlashCommands = [],
  onSlashPickerOpen = () => {}
}) {
  const textareaRef = useRef(null);
  const imageInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const voiceChunksRef = useRef([]);
  const voiceStreamRef = useRef(null);
  const voiceTimerRef = useRef(null);
  const voiceErrorTimerRef = useRef(null);
  const [openMenu, setOpenMenu] = useState(null);
  const [voiceState, setVoiceState] = useState('idle');
  const [voiceError, setVoiceError] = useState('');
  // The `/` picker candidate pool. On claude it merges CLI-discovered commands
  // in; nothing here depends on the typed query, so memoize it instead of
  // rebuilding on every keystroke (filteredSlashCommands does the per-query work).
  const slashPool = useMemo(
    () => (agentId === 'claude' ? mergeSlashCommandsForClaude(SLASH_COMMANDS, claudeSlashCommands) : SLASH_COMMANDS),
    [agentId, claudeSlashCommands]
  );
  // Token panel state for @文件 / `/` 命令 picker. `composerToken` is the
  // detected trigger (or null); fileSearchResults / fileSearchLoading drive
  // the @-file picker contents while the user types after the @.
  const [composerToken, setComposerToken] = useState(null);
  const [fileSearchResults, setFileSearchResults] = useState([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  // # quick-prompt picker state. Loaded lazily — first '#' detection
  // pulls from localStorage so this stays out of the cold-load path.
  const [quickPrompts, setQuickPrompts] = useState({ pinned: [], recent: [] });
  const [quickPromptsLoaded, setQuickPromptsLoaded] = useState(false);

  function ensureQuickPromptsLoaded() {
    if (quickPromptsLoaded) return quickPrompts;
    const loaded = getStoredPrompts();
    setQuickPrompts(loaded);
    setQuickPromptsLoaded(true);
    return loaded;
  }

  function applyQuickPrompt(entry) {
    if (!composerToken || !entry?.prompt) return;
    // Replace the `#query` with the expanded prompt text; user can edit
    // it further before sending. Add a trailing space so subsequent typing
    // doesn't merge with the prompt word.
    const replacement = `${entry.prompt} `;
    const next = replaceComposerToken(input, composerToken, replacement);
    setInput(next);
    setComposerToken(null);
    // Record usage so this prompt rises to the top of "recent" next time.
    const updated = recordPromptUse(entry.prompt);
    setQuickPrompts(updated);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const cursor = Math.min(next.length, composerToken.start + replacement.length);
      textareaRef.current?.setSelectionRange?.(cursor, cursor);
    });
  }

  function togglePinQuickPrompt(entry) {
    if (!entry?.prompt) return;
    // If this entry is already pinned (has an id), unpin. Otherwise pin
    // it — derive an id from current timestamp + prompt hash-ish slice.
    const isPinned = quickPrompts.pinned.some((p) => p.id === entry.id);
    if (isPinned) {
      setQuickPrompts(unpinPrompt(entry.id, undefined));
      return;
    }
    const id = `user-${Date.now()}-${(entry.prompt || '').slice(0, 8).replace(/\W/g, '')}`;
    setQuickPrompts(pinPrompt({ id, label: entry.label, prompt: entry.prompt }, undefined));
  }
  const agent = agentMeta(status);
  const hasInput = input.trim().length > 0 || attachments.length > 0;
  const runningInputMode = running && hasInput;
  const canSteerCurrentTask = canGuideCurrentTaskForSend({
    agentId: agent.id,
    running: runningInputMode,
    selectedSessionId: selectedSession?.id || '',
    sessionIsDraft: isDraftSession(selectedSession),
    desktopBridge
  });
  const canSteerQueuedDraft = canGuideCurrentTaskForSend({
    agentId: agent.id,
    running: true,
    selectedSessionId: selectedSession?.id || '',
    sessionIsDraft: isDraftSession(selectedSession),
    desktopBridge
  });
  const sendButtonLabel = running && !hasInput
    ? '中止当前任务'
    : runningInputMode
      ? '选择发送方式'
      : '发送消息';

  function submitRunningMode(mode) {
    if (mode === 'steer' && !canSteerCurrentTask) {
      return;
    }
    onSubmit({ mode });
    setOpenMenu(null);
  }

  function refreshComposerToken(value, cursor) {
    const token = detectComposerToken(value, cursor);
    if (!token) {
      setComposerToken(null);
      setOpenMenu(null);
      return;
    }
    setOpenMenu(null);
    if (token.type === 'skill' && !availableSkills.length) {
      setComposerToken(null);
      return;
    }
    if (token.type === 'quick-prompt') {
      ensureQuickPromptsLoaded();
    }
    // Fire a (throttled) refresh whenever the user opens the `/` picker so
    // newly-added skills / commands appear without switching session. The
    // hook itself caps requests to one per 30s.
    if (token.type === 'slash' && composerToken?.type !== 'slash') {
      onSlashPickerOpen();
    }
    setComposerToken(token);
  }

  function selectSkillFromToken(skill) {
    if (!composerToken || !skill?.path) return;
    onChangeSelectedSkills(toggleSkill(selectedSkills, skill));
    const next = replaceComposerToken(input, composerToken, '');
    setInput(next);
    setComposerToken(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const cursor = Math.max(0, composerToken.start);
      textareaRef.current?.setSelectionRange?.(cursor, cursor);
    });
  }

  function handleComposerChange(event) {
    const value = event.target.value;
    setInput(value);
    refreshComposerToken(value, event.target.selectionStart ?? value.length);
  }

  function handleComposerSelect(event) {
    refreshComposerToken(event.target.value, event.target.selectionStart ?? 0);
  }

  function applyTokenReplacement(replacement) {
    if (!composerToken) {
      return;
    }
    const next = replaceComposerToken(input, composerToken, replacement);
    setInput(next);
    setComposerToken(null);
    setFileSearchResults([]);
    // Focus + position caret just past the replacement so the next keystroke
    // continues the message instead of restarting the picker.
    const targetIndex = composerToken.start + replacement.length;
    window.requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(targetIndex, targetIndex);
      }
    });
  }

  function selectSlashCommand(command) {
    if (command.action === 'insert-prompt') {
      applyTokenReplacement(`${command.prompt} `);
      return;
    }
    if (command.action === 'open-context') {
      // /状态 → strip the partial /状态 token, then open the status popover
      // anchored to the composer (matches upstream's setOpenMenu('context')
      // pattern). The popover renders the panel below using local data only:
      // model / reasoning / permission / connection (+ desktop bridge on
      // codex route). When backend ships contextStatus runtime metrics
      // (input_tokens / context_window / autoCompact), upgrade the popover
      // to upstream's ContextStatusDetails.
      applyTokenReplacement('');
      setOpenMenu('context');
      return;
    }
    if (command.action === 'compact') {
      applyTokenReplacement('');
      onCompact?.();
      return;
    }
    if (command.action === 'force-image') {
      // /image → one-shot forceImage flag for the next send.
      applyTokenReplacement('');
      onToggleForceImage(true);
      return;
    }
    if (command.action === 'plan-mode') {
      // /plan → drive body.collaborationMode for the next send.
      applyTokenReplacement('');
      onTogglePlanMode(true);
      return;
    }
    if (command.action === 'cli-passthrough') {
      // CLI slash commands (built-in / user / project) are processed by
      // `claude -p` itself when our server forwards the prompt verbatim.
      // The picker just rewrites the partial token into the full command
      // with a trailing space so the user can type args and hit send.
      applyTokenReplacement(`${command.token} `);
      return;
    }
    if (command.action === 'select-skill') {
      // /代码审查 → auto-toggle named skill if present, otherwise fall back to
      // the legacy prompt-injection so the command stays useful for users who
      // have not installed the skill.
      const target = command.skillName
        ? availableSkills.find((s) => s.name === command.skillName)
        : null;
      if (target) {
        applyTokenReplacement('');
        if (!selectedSkills.some((s) => s.path === target.path)) {
          onChangeSelectedSkills([...selectedSkills, target]);
        }
        return;
      }
      if (command.fallbackPrompt) {
        applyTokenReplacement(`${command.fallbackPrompt} `);
      } else {
        applyTokenReplacement('');
      }
      return;
    }
    // Unknown action: just dismiss the picker and clear the partial /token.
    applyTokenReplacement('');
  }

  function selectFile(file) {
    applyTokenReplacement(`@${file.relativePath} `);
  }

  // Debounce file search while user types after @ — fires whenever the token
  // text or selected project changes; cancels on unmount / token replacement.
  useEffect(() => {
    if (composerToken?.type !== 'file') {
      setFileSearchResults([]);
      setFileSearchLoading(false);
      return undefined;
    }
    if (!selectedProject?.id) {
      setFileSearchResults([]);
      setFileSearchLoading(false);
      return undefined;
    }
    let cancelled = false;
    setFileSearchLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const data = await apiFetch(
          `/api/files/search?projectId=${encodeURIComponent(selectedProject.id)}&q=${encodeURIComponent(composerToken.query)}`
        );
        if (!cancelled) {
          setFileSearchResults(Array.isArray(data?.files) ? data.files : []);
        }
      } catch {
        if (!cancelled) {
          setFileSearchResults([]);
        }
      } finally {
        if (!cancelled) {
          setFileSearchLoading(false);
        }
      }
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [composerToken?.type, composerToken?.query, selectedProject?.id]);
  // Drop the hardcoded 'gpt-5.5' fallback — it leaked a Codex model name
  // onto the Claude route. shortModelName() returns '--' for empty input.
  const effectiveModel = selectedModel || status?.model || '';
  const modelList = models?.length
    ? models
    : (effectiveModel ? [{ value: effectiveModel, label: effectiveModel }] : []);
  const selectedModelLabel = modelList.find((model) => model.value === effectiveModel)?.label || effectiveModel;
  const selectedPermissionLabel = isClaudeProvider(status) && permissionMode === 'default'
    ? '自动接受编辑'
    : permissionLabel(permissionMode);
  const runtimeSummary = `${agent.shortLabel} · ${shortModelName(selectedModelLabel)} ${reasoningLabel(selectedReasoningEffort)} · ${selectedPermissionLabel}`;
  const voiceRecording = voiceState === 'recording';
  const voiceTranscribing = voiceState === 'transcribing';
  const voiceSending = voiceState === 'sending';

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  }, [input]);

  useEffect(() => () => {
    clearVoiceTimer();
    clearVoiceErrorTimer();
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
    }
    stopVoiceStream();
  }, []);

  function submit(event) {
    event.preventDefault();
    if (running && !hasInput) {
      onAbort();
      return;
    }
    if (runningInputMode) {
      setOpenMenu((current) => (current === 'send-mode' ? null : 'send-mode'));
      return;
    }
    if (hasInput) {
      onSubmit({ mode: 'start' });
      setOpenMenu(null);
    }
  }

  function toggleMenu(name) {
    setComposerToken(null);
    setOpenMenu((current) => (current === name ? null : name));
  }

  function handleFiles(event, kind) {
    const files = Array.from(event.target.files || []);
    if (files.length) {
      onUploadFiles(files, kind);
    }
    event.target.value = '';
    setOpenMenu(null);
  }

  function setVoiceErrorBriefly(message) {
    clearVoiceErrorTimer();
    setVoiceError(message);
    voiceErrorTimerRef.current = window.setTimeout(() => {
      setVoiceError('');
      voiceErrorTimerRef.current = null;
    }, 2600);
  }

  function clearVoiceErrorTimer() {
    if (voiceErrorTimerRef.current) {
      window.clearTimeout(voiceErrorTimerRef.current);
      voiceErrorTimerRef.current = null;
    }
  }

  function clearVoiceTimer() {
    if (voiceTimerRef.current) {
      window.clearTimeout(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
  }

  function stopVoiceStream() {
    voiceStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    voiceStreamRef.current = null;
  }

  function voiceMimeType() {
    if (!window.MediaRecorder?.isTypeSupported) {
      return '';
    }
    return VOICE_MIME_CANDIDATES.find((type) => window.MediaRecorder.isTypeSupported(type)) || '';
  }

  async function transcribeVoiceBlob(blob) {
    if (!blob?.size) {
      setVoiceErrorBriefly('没有录到声音');
      return '';
    }
    if (blob.size > VOICE_MAX_UPLOAD_BYTES) {
      setVoiceErrorBriefly('录音超过 10MB');
      return '';
    }

    const formData = new FormData();
    const extension = blob.type.includes('mp4') ? 'm4a' : 'webm';
    formData.append('audio', blob, `voice.${extension}`);

    try {
      const result = await apiFetch('/api/voice/transcribe', {
        method: 'POST',
        body: formData
      });
      if (!result.text?.trim()) {
        setVoiceErrorBriefly('没有识别到文字');
        return '';
      }
      return result.text.trim();
    } catch (error) {
      setVoiceErrorBriefly(error.message || '语音转写失败');
      return '';
    }
  }

  async function startVoiceRecording() {
    setOpenMenu(null);
    clearVoiceErrorTimer();
    setVoiceError('');
    if (window.location.protocol !== 'https:') {
      setVoiceErrorBriefly('请使用 HTTPS 地址或 iOS 键盘听写');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setVoiceErrorBriefly('当前浏览器不支持录音');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = voiceMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      voiceStreamRef.current = stream;
      voiceChunksRef.current = [];
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          voiceChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        clearVoiceTimer();
        stopVoiceStream();
        setVoiceState('idle');
        setVoiceErrorBriefly('录音失败');
      };
      recorder.onstop = async () => {
        clearVoiceTimer();
        stopVoiceStream();
        const recordedType = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(voiceChunksRef.current, { type: recordedType });
        voiceChunksRef.current = [];
        mediaRecorderRef.current = null;
        try {
          setVoiceState('transcribing');
          const transcript = await transcribeVoiceBlob(blob);
          if (transcript) {
            setVoiceState('sending');
            await onVoiceSubmit(transcript);
          }
        } catch (error) {
          setVoiceErrorBriefly(error.message || '语音发送失败');
        } finally {
          setVoiceState('idle');
        }
      };

      recorder.start();
      setVoiceState('recording');
      voiceTimerRef.current = window.setTimeout(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
          setVoiceState('transcribing');
          mediaRecorderRef.current.stop();
        }
      }, VOICE_MAX_RECORDING_MS);
    } catch (error) {
      clearVoiceTimer();
      stopVoiceStream();
      mediaRecorderRef.current = null;
      setVoiceState('idle');
      const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
      setVoiceErrorBriefly(denied ? '麦克风权限被拒绝' : '录音启动失败');
    }
  }

  function stopVoiceRecording() {
    if (mediaRecorderRef.current?.state === 'recording') {
      clearVoiceErrorTimer();
      setVoiceError('');
      setVoiceState('transcribing');
      mediaRecorderRef.current.stop();
      return;
    }
    clearVoiceTimer();
    stopVoiceStream();
    setVoiceState('idle');
  }

  function toggleVoiceInput() {
    if (voiceRecording) {
      stopVoiceRecording();
    } else if (!voiceTranscribing && !voiceSending) {
      startVoiceRecording();
    }
  }

  return (
    <form className={`composer-wrap ${agent.accentClass}`} onSubmit={submit}>
      <input
        ref={imageInputRef}
        className="file-input"
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => handleFiles(event, 'image')}
      />
      <input
        ref={fileInputRef}
        className="file-input"
        type="file"
        multiple
        onChange={(event) => handleFiles(event, 'file')}
      />
      {openMenu === 'attach' ? (
        <div className="composer-menu attach-menu">
          <button type="button" onClick={() => imageInputRef.current?.click()}>
            <Image size={17} />
            相册
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()}>
            <FileText size={17} />
            文件
          </button>
          <button
            type="button"
            onClick={() => {
              setOpenMenu(null);
              onOpenSkillPicker();
            }}
            disabled={!availableSkills.length}
          >
            <BookOpen size={17} />
            <span>{selectedSkills.length ? `技能 ${selectedSkills.length}` : '技能'}</span>
          </button>
          <div className="menu-divider" />
          <button type="button" className="composer-menu-detail" onClick={() => setOpenMenu('runtime')}>
            <Settings2 size={17} />
            <span>
              <strong>运行设置</strong>
              <small>{runtimeSummary}</small>
            </span>
            <ChevronRight size={16} />
          </button>
          <button
            type="button"
            className={`composer-menu-detail ${voiceDialogActive ? 'is-selected' : ''}`}
            onClick={() => {
              setOpenMenu(null);
              onOpenVoiceDialog?.();
            }}
          >
            <Headphones size={17} />
            <span>
              <strong>连续语音对话</strong>
              <small>{voiceDialogActive ? '正在进行' : '实时对话；一次性语音仍用麦克风按钮'}</small>
            </span>
          </button>
        </div>
      ) : null}
      {openMenu === 'runtime' ? (
        <div className="composer-menu runtime-menu">
          <div className="menu-section-label">运行设置</div>
          <button type="button" className="composer-menu-detail" onClick={() => setOpenMenu('model')}>
            <Settings2 size={17} />
            <span>
              <strong>模型与推理</strong>
              <small>{agent.shortLabel} · {shortModelName(selectedModelLabel)} · {reasoningLabel(selectedReasoningEffort)}</small>
            </span>
            <ChevronRight size={16} />
          </button>
          <button type="button" className="composer-menu-detail" onClick={() => setOpenMenu('permission')}>
            <Check size={17} />
            <span>
              <strong>权限</strong>
              <small>{selectedPermissionLabel}</small>
            </span>
            <ChevronRight size={16} />
          </button>
          {selectedSession?.workingDir ? (
            <div className="runtime-context-row">
              <span>工作区</span>
              <strong>{selectedSession.workingBranch || selectedSession.workingDir}</strong>
            </div>
          ) : null}
        </div>
      ) : null}
      {openMenu === 'permission' ? (
        <div className="composer-menu permission-menu">
          {PERMISSION_OPTIONS.filter((option) => !isClaudeProvider(status) || option.value !== 'default').map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${permissionMode === option.value ? 'is-selected' : ''} ${option.danger ? 'is-danger' : ''}`}
              onClick={() => {
                onSelectPermission(option.value);
                setOpenMenu(null);
              }}
            >
              <span className="menu-radio" aria-hidden="true" />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      {openMenu === 'model' ? (
        <div className="composer-menu model-menu">
          <div className="model-menu-col">
            <div className="menu-section-label">模型</div>
            {modelList.map((model) => (
              <button
                key={model.value}
                type="button"
                className={effectiveModel === model.value ? 'is-selected' : ''}
                onClick={() => {
                  onSelectModel(model.value);
                  setOpenMenu(null);
                }}
              >
                <span className="menu-radio" aria-hidden="true" />
                <span>{model.label}</span>
              </button>
            ))}
          </div>
          <div className="model-menu-col">
            <div className="menu-section-label">智能</div>
            {REASONING_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={selectedReasoningEffort === option.value ? 'is-selected' : ''}
                onClick={() => {
                  onSelectReasoningEffort(option.value);
                  setOpenMenu(null);
                }}
              >
                <span className="menu-radio" aria-hidden="true" />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {voiceState !== 'idle' || voiceError ? (
        <div className={`voice-popover ${voiceError ? 'is-error' : ''}`}>
          <Mic size={14} />
          <span>{voiceError || (voiceSending ? '正在发送...' : voiceTranscribing ? '正在转写...' : '正在录音...')}</span>
        </div>
      ) : null}
      {imageIntentConfirmation ? (
        <div className="image-intent-confirmation" role="status" aria-label="图片生成确认">
          <div>
            <strong>{imageIntentConfirmation.prompt || '要生成图片吗？'}</strong>
            <small>{imageIntentConfirmation.intent === 'edit' ? '这条消息可能是在请求图片编辑。' : '这条消息可能是在请求图片生成。'}</small>
          </div>
          <div className="image-intent-actions">
            <button type="button" onClick={() => onResolveImageIntent?.('force')}>生成图片</button>
            <button type="button" onClick={() => onResolveImageIntent?.('skip')}>按普通消息发送</button>
            <button type="button" aria-label="取消图片生成确认" onClick={() => onResolveImageIntent?.('cancel')}>
              <X size={14} />
            </button>
          </div>
        </div>
      ) : null}
      {queueDrafts.length ? (
        <div className="queued-drafts-panel" aria-label="排队消息">
          {queueDrafts.map((draft) => (
            <div key={draft.id} className="queued-draft-row">
              <MessageSquarePlus size={15} />
              <button
                type="button"
                className="queued-draft-text"
                onClick={() => onRestoreQueueDraft?.(draft.id)}
              >
                <strong>{draft.text || '请查看附件。'}</strong>
                <small>{draft.selectedSkills?.length ? `${draft.selectedSkills.length} skills` : '排队中'}</small>
              </button>
              <div className="queued-draft-actions">
                <button
                  type="button"
                  disabled={!canSteerQueuedDraft}
                  onClick={() => {
                    Promise.resolve(onSteerQueueDraft?.(draft.id)).catch((error) => {
                      console.warn('[queue] steer queued draft failed:', error?.message || error);
                    });
                  }}
                  aria-label={canSteerQueuedDraft ? '立即发送到当前任务' : '当前任务暂时不能接收补充消息'}
                  title={canSteerQueuedDraft ? '立即发送到当前任务' : '当前任务暂时不能接收补充消息'}
                >
                  <MessageSquare size={14} />
                </button>
                <button type="button" onClick={() => onRemoveQueueDraft?.(draft.id)} aria-label="删除排队消息">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {runningInputMode ? (
        <div className="send-mode-strip" role="group" aria-label="运行中发送方式">
          <button
            type="button"
            className="is-primary"
            disabled={!canSteerCurrentTask}
            onClick={() => submitRunningMode('steer')}
          >
            <MessageSquare size={14} />
            <span>引导当前</span>
          </button>
          <button type="button" onClick={() => submitRunningMode('queue')}>
            <MessageSquarePlus size={14} />
            <span>排队</span>
          </button>
          <button type="button" className="is-danger" onClick={() => submitRunningMode('interrupt')}>
            <Square size={13} />
            <span>打断</span>
          </button>
        </div>
      ) : null}
      {openMenu === 'send-mode' ? (
        <div className="composer-menu send-mode-menu">
          <button
            type="button"
            disabled={!canSteerCurrentTask}
            onClick={() => {
              submitRunningMode('steer');
            }}
          >
            <MessageSquare size={16} />
            <span>
              <strong>发送到当前任务</strong>
              <small>{canSteerCurrentTask ? '直接补充给桌面端正在执行的任务' : '当前任务暂时不能接收补充消息'}</small>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              submitRunningMode('queue');
            }}
          >
            <MessageSquarePlus size={16} />
            <span>
              <strong>加入队列</strong>
              <small>当前任务结束后自动发送</small>
            </span>
          </button>
          <button
            type="button"
            className="is-danger"
            onClick={() => {
              submitRunningMode('interrupt');
            }}
          >
            <Square size={15} />
            <span>
              <strong>中止并发送</strong>
              <small>停下当前任务，用这条消息重新引导</small>
            </span>
          </button>
        </div>
      ) : null}
      {openMenu === 'context' ? (
        <div className="composer-menu status-menu" role="status">
          <div className="menu-section-label">{agent.shortLabel} · 状态</div>
          <div className="status-menu-body">
            <div className="status-menu-row">
              <span className="status-menu-label">模型</span>
              <span>{shortModelName(selectedModelLabel)} · {reasoningLabel(selectedReasoningEffort)}</span>
            </div>
            <div className="status-menu-row">
              <span className="status-menu-label">权限</span>
              <span>{selectedPermissionLabel}</span>
            </div>
            <div className="status-menu-row">
              <span className="status-menu-label">连接</span>
              <span>
                {connectionState === 'connected'
                  ? '已连接'
                  : connectionState === 'connecting'
                    ? '连接中'
                    : '已断开'}
              </span>
            </div>
            {agent.id === 'codex' ? (
              <div className="status-menu-row">
                <span className="status-menu-label">桌面端</span>
                <span>{desktopBridge?.connected ? '在线' : (desktopBridge?.reason || '离线')}</span>
              </div>
            ) : null}
            <div className="status-menu-row">
              <span className="status-menu-label">路线</span>
              <span>{agent.label}</span>
            </div>
          </div>
        </div>
      ) : null}
      {composerToken && composerToken.type === 'slash' ? (
        <div className="composer-menu token-menu slash-menu">
          {(() => {
            const matches = filteredSlashCommands(composerToken.query, slashPool);
            if (!matches.length) {
              return (
                <button type="button" disabled>
                  <span className="menu-spacer" />
                  <span>没有匹配的命令</span>
                </button>
              );
            }
            return matches.map((command) => (
              <button
                key={command.id}
                type="button"
                className="slash-menu-row"
                onClick={() => selectSlashCommand(command)}
              >
                <span className="slash-menu-token">{command.token}</span>
                {command.description ? (
                  <span className="slash-menu-hint">{command.description}</span>
                ) : null}
              </button>
            ));
          })()}
        </div>
      ) : null}
      {composerToken && composerToken.type === 'skill' ? (
        <div className="composer-menu token-menu">
          {(() => {
            const matches = filteredSkillsForToken(composerToken.query, availableSkills);
            if (!matches.length) {
              return (
                <button type="button" disabled>
                  <span className="menu-spacer" />
                  <span>没有匹配的技能</span>
                </button>
              );
            }
            return matches.slice(0, 8).map((skill) => {
              const selected = isSkillSelected(selectedSkills, skill);
              return (
                <button key={skill.path} type="button" onClick={() => selectSkillFromToken(skill)}>
                  <span className="menu-spacer">{selected ? <Check size={12} /> : null}</span>
                  <span>{skill.name || skill.path}</span>
                  {skill.description ? <small className="token-menu-token">{skill.description}</small> : null}
                </button>
              );
            });
          })()}
        </div>
      ) : null}
      {composerToken && composerToken.type === 'quick-prompt' ? (
        <div className="composer-menu token-menu quick-prompt-menu">
          {(() => {
            const filtered = filteredQuickPrompts(composerToken.query, quickPrompts);
            const totalCount = filtered.pinned.length + filtered.recent.length;
            if (totalCount === 0) {
              return (
                <button type="button" disabled>
                  <span className="menu-spacer" />
                  <span>没有匹配的快捷提示</span>
                </button>
              );
            }
            const renderRow = (entry, kind) => {
              const isPinned = kind === 'pinned';
              const label = entry.label || entry.prompt.slice(0, 24);
              return (
                <div key={entry.id || entry.prompt} className="quick-prompt-row">
                  <button
                    type="button"
                    className="quick-prompt-pick"
                    onClick={() => applyQuickPrompt(entry)}
                    title={entry.prompt}
                  >
                    <span className="menu-spacer" />
                    <span className="quick-prompt-label">{label}</span>
                    <small className="token-menu-token">{entry.prompt.slice(0, 60)}{entry.prompt.length > 60 ? '…' : ''}</small>
                  </button>
                  <button
                    type="button"
                    className="quick-prompt-pin"
                    onClick={(e) => { e.stopPropagation(); togglePinQuickPrompt(entry); }}
                    title={isPinned ? '取消固定' : '固定'}
                    aria-label={isPinned ? '取消固定' : '固定'}
                  >
                    {isPinned ? '★' : '☆'}
                  </button>
                </div>
              );
            };
            return (
              <>
                {filtered.pinned.length > 0 && (
                  <div className="quick-prompt-section-label">已固定</div>
                )}
                {filtered.pinned.map((entry) => renderRow(entry, 'pinned'))}
                {filtered.recent.length > 0 && (
                  <div className="quick-prompt-section-label">最近用过</div>
                )}
                {filtered.recent.map((entry) => renderRow(entry, 'recent'))}
              </>
            );
          })()}
        </div>
      ) : null}
      {composerToken && composerToken.type === 'file' ? (
        <div className="composer-menu token-menu">
          {!selectedProject ? (
            <button type="button" disabled>
              <span className="menu-spacer" />
              <span>未选择项目</span>
            </button>
          ) : fileSearchLoading ? (
            <button type="button" disabled>
              <span className="menu-spacer" />
              <span>搜索中…</span>
            </button>
          ) : fileSearchResults.length ? (
            fileSearchResults.slice(0, 8).map((file) => (
              <button key={file.relativePath} type="button" onClick={() => selectFile(file)}>
                <span className="menu-spacer" />
                <span>{file.relativePath}</span>
              </button>
            ))
          ) : (
            <button type="button" disabled>
              <span className="menu-spacer" />
              <span>无匹配文件</span>
            </button>
          )}
        </div>
      ) : null}
      <div className="composer">
        {(planModeActive || forceImageActive) ? (
          <div className="composer-mode-tray">
            {planModeActive ? (
              <span className="composer-mode-chip is-plan">
                <span>📋 计划模式</span>
                <button type="button" onClick={() => onTogglePlanMode(false)} aria-label="退出计划模式">
                  <X size={12} />
                </button>
              </span>
            ) : null}
            {forceImageActive ? (
              <span className="composer-mode-chip is-image">
                <span>🎨 强制生图</span>
                <button type="button" onClick={() => onToggleForceImage(false)} aria-label="取消强制生图">
                  <X size={12} />
                </button>
              </span>
            ) : null}
          </div>
        ) : null}
        {selectedSkills.length ? (
          <div className="skill-chip-tray">
            {selectedSkills.map((skill) => (
              <span key={skill.path} className="skill-chip">
                <BookOpen size={12} aria-hidden="true" />
                <span>{skill.name || skill.path}</span>
                <button
                  type="button"
                  onClick={() => onChangeSelectedSkills(selectedSkills.filter((entry) => entry.path !== skill.path))}
                  aria-label={`移除技能 ${skill.name || ''}`}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {attachments.length ? (
          <div className="attachment-tray">
            {attachments.map((attachment) => {
              const isImage = isImageAttachment(attachment);
              const token = getToken();
              const previewHref = attachment.path ? localFilePreviewPath(attachment.path, token) : '';
              const thumbnailSrc = isImage ? attachmentPreviewUrl(attachment, token) : '';
              return (
                <span key={attachment.id} className="attachment-chip">
                  {thumbnailSrc ? (
                    <img
                      src={thumbnailSrc}
                      alt=""
                      className="attachment-thumb"
                      width={20}
                      height={20}
                    />
                  ) : (
                    <Paperclip size={14} />
                  )}
                  {previewHref ? (
                    <a href={previewHref} target="_blank" rel="noreferrer">
                      {attachment.name}
                    </a>
                  ) : (
                    <span>{attachment.name}</span>
                  )}
                  <small>{formatBytes(attachment.size)}</small>
                  <button type="button" onClick={() => onRemoveAttachment(attachment.id)} aria-label="移除附件">
                    <Trash2 size={13} />
                  </button>
                </span>
              );
            })}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={handleComposerChange}
          onSelect={handleComposerSelect}
          placeholder={agent.placeholder}
        />
        <div className="composer-controls">
          <div className="control-left">
            <button type="button" className="ghost-icon" aria-label="添加与更多" onClick={() => toggleMenu('attach')} disabled={uploading}>
              <Plus size={21} />
            </button>
          </div>
          <div className="control-right">
            <button
              type="button"
              className={`voice-button ${voiceRecording ? 'is-recording' : ''} ${voiceTranscribing ? 'is-transcribing' : ''} ${voiceSending ? 'is-sending' : ''}`}
              onClick={toggleVoiceInput}
              disabled={voiceTranscribing || voiceSending}
              aria-label={voiceRecording ? '停止语音输入' : voiceTranscribing ? '正在转写语音' : voiceSending ? '正在发送语音' : '语音输入：录音转文字并发送'}
            >
              {voiceTranscribing || voiceSending ? <Loader2 className="spin" size={16} /> : <Mic size={17} />}
            </button>
            <button
              type="submit"
              className={`send-button ${running ? 'is-running' : ''} ${runningInputMode ? 'is-choose-mode' : ''}`}
              disabled={uploading || (!hasInput && !running)}
              title={sendButtonLabel}
              aria-label={sendButtonLabel}
            >
              {running && !hasInput ? <Square size={16} /> : uploading ? <Loader2 className="spin" size={16} /> : <ArrowUp size={19} />}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
