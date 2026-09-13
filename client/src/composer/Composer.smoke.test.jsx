import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { Composer } from './Composer.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;

function renderComposer(overrides = {}) {
  const props = {
    input: '',
    setInput: vi.fn(),
    onSubmit: vi.fn(),
    running: false,
    onAbort: vi.fn(),
    onSteer: vi.fn(),
    models: [{ value: 'gpt-5.6', label: 'GPT-5.6' }],
    selectedModel: 'gpt-5.6',
    onSelectModel: vi.fn(),
    selectedReasoningEffort: 'high',
    onSelectReasoningEffort: vi.fn(),
    permissionMode: 'bypassPermissions',
    onSelectPermission: vi.fn(),
    attachments: [],
    onUploadFiles: vi.fn(),
    onRemoveAttachment: vi.fn(),
    uploading: false,
    onVoiceSubmit: vi.fn(),
    onOpenVoiceDialog: vi.fn(),
    voiceDialogActive: false,
    selectedProject: { id: 'project-1', name: 'Mobile Project', path: 'D:/example/mobile-project' },
    selectedSession: {
      id: 'session-1',
      title: 'Current task',
      workingDir: 'D:/example/mobile-project/.worktrees/demo',
      workingBranch: 'feature/demo'
    },
    onOpenStatus: vi.fn(),
    onCompact: vi.fn(),
    connectionState: 'connected',
    desktopBridge: { connected: false, mode: 'headless-local' },
    status: { provider: 'codex', model: 'gpt-5.6' },
    queueDrafts: [],
    onRemoveQueueDraft: vi.fn(),
    onRestoreQueueDraft: vi.fn(),
    onSteerQueueDraft: vi.fn(),
    imageIntentConfirmation: null,
    onResolveImageIntent: vi.fn(),
    availableSkills: [],
    selectedSkills: [],
    onChangeSelectedSkills: vi.fn(),
    onOpenSkillPicker: vi.fn(),
    forceImageActive: false,
    onToggleForceImage: vi.fn(),
    planModeActive: false,
    onTogglePlanMode: vi.fn(),
    agentId: 'codex',
    claudeSlashCommands: [],
    onSlashPickerOpen: vi.fn(),
    ...overrides
  };
  root.render(<Composer {...props} />);
  return props;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

test('primary composer keeps only add, one-shot voice, and send controls', async () => {
  await act(async () => renderComposer());

  expect(container.querySelector('.permission-pill')).toBeNull();
  expect(container.querySelector('.model-select')).toBeNull();
  expect(container.querySelector('.dialog-button')).toBeNull();
  expect(container.querySelector('[aria-label="添加与更多"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="语音输入：录音转文字并发送"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="发送消息"]')).not.toBeNull();
});

test('add menu exposes runtime settings and continuous voice as secondary actions', async () => {
  await act(async () => renderComposer());
  const more = container.querySelector('[aria-label="添加与更多"]');
  await act(async () => more.click());

  const attachMenu = container.querySelector('.attach-menu');
  expect(attachMenu?.textContent).toContain('相册');
  expect(attachMenu?.textContent).toContain('文件');
  expect(attachMenu?.textContent).toContain('运行设置');
  expect(attachMenu?.textContent).toContain('连续语音对话');

  const runtimeButton = [...attachMenu.querySelectorAll('button')]
    .find((button) => button.textContent.includes('运行设置'));
  await act(async () => runtimeButton.click());

  const runtimeMenu = container.querySelector('.runtime-menu');
  expect(runtimeMenu?.textContent).toContain('模型与推理');
  expect(runtimeMenu?.textContent).toContain('5.6');
  expect(runtimeMenu?.textContent).toContain('高');
  expect(runtimeMenu?.textContent).toContain('权限');
  expect(runtimeMenu?.textContent).toContain('完全访问');
  expect(runtimeMenu?.textContent).toContain('feature/demo');

  const modelButton = [...runtimeMenu.querySelectorAll('button')]
    .find((button) => button.textContent.includes('模型与推理'));
  await act(async () => modelButton.click());
  expect(container.querySelector('.model-menu')?.textContent).toContain('5.6');
  expect(container.querySelector('.model-menu')?.textContent).toContain('高');

  await act(async () => container.querySelector('[aria-label="添加与更多"]').click());
  const reopenRuntime = [...container.querySelectorAll('.attach-menu button')]
    .find((button) => button.textContent.includes('运行设置'));
  await act(async () => reopenRuntime.click());
  const permissionButton = [...container.querySelectorAll('.runtime-menu button')]
    .find((button) => button.textContent.includes('权限'));
  await act(async () => permissionButton.click());
  expect(container.querySelector('.permission-menu')?.textContent).toContain('完全访问');
});

test('continuous voice is distinct from the primary one-shot voice input', async () => {
  const onOpenVoiceDialog = vi.fn();
  await act(async () => renderComposer({ onOpenVoiceDialog }));
  await act(async () => container.querySelector('[aria-label="添加与更多"]').click());

  const continuousVoice = [...container.querySelectorAll('.attach-menu button')]
    .find((button) => button.textContent.includes('连续语音对话'));
  expect(continuousVoice.textContent).toContain('一次性语音仍用麦克风按钮');
  await act(async () => continuousVoice.click());

  expect(onOpenVoiceDialog).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[aria-label="语音输入：录音转文字并发送"]')).not.toBeNull();
});
