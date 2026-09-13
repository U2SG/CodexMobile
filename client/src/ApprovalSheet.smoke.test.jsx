import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import React from 'react';

import ApprovalSheet from './ApprovalSheet.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mount(jsx) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(jsx);
  });
  return {
    container,
    rerender(next) {
      act(() => {
        root.render(next);
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  };
}

function findButton(container, text) {
  for (const btn of container.querySelectorAll('button')) {
    if (btn.textContent === text) return btn;
  }
  return null;
}

// Option buttons concatenate label + description in their textContent, so
// exact-match findButton won't locate them — match the label prefix instead.
function findOption(container, label) {
  for (const btn of container.querySelectorAll('button')) {
    if (btn.textContent.startsWith(label)) return btn;
  }
  return null;
}

describe('ApprovalSheet', () => {
  it('renders nothing when the queue is empty', () => {
    const { container, unmount } = mount(<ApprovalSheet requests={[]} onRespond={() => null} />);
    expect(container.textContent).toBe('');
    unmount();
  });

  it('renders the exec-command preview and ships approved on the once button', () => {
    const onRespond = vi.fn();
    const { container, unmount } = mount(
      <ApprovalSheet
        requests={[{
          requestId: 'req-1',
          turnId: 't-1',
          kind: 'execCommand',
          params: { command: 'curl https://example.com', cwd: 'D:/proj', reason: 'need net' }
        }]}
        onRespond={onRespond}
      />
    );
    expect(container.textContent).toContain('Codex 想执行命令');
    expect(container.textContent).toContain('need net');
    const btn = findButton(container, '允许本次');
    expect(btn).not.toBeNull();
    act(() => { btn.click(); });
    expect(onRespond).toHaveBeenCalledWith('req-1', { decision: 'approved' });
    unmount();
  });

  it('shows the queue counter when more than one is pending', () => {
    const { container, unmount } = mount(
      <ApprovalSheet
        requests={[
          { requestId: 'req-1', turnId: 't', kind: 'execCommand', params: { command: 'ls' } },
          { requestId: 'req-2', turnId: 't', kind: 'fileChange', params: { fileChanges: { 'foo.js': {} } } }
        ]}
        onRespond={() => null}
      />
    );
    expect(container.textContent).toContain('还有 1 个待确认');
    unmount();
  });

  it('passes approved_for_session for the session button', () => {
    const onRespond = vi.fn();
    const { container, unmount } = mount(
      <ApprovalSheet
        requests={[{
          requestId: 'r',
          turnId: 't',
          kind: 'execCommand',
          params: { command: 'whoami' }
        }]}
        onRespond={onRespond}
      />
    );
    act(() => { findButton(container, '本会话总是允许').click(); });
    expect(onRespond).toHaveBeenCalledWith('r', { decision: 'approved_for_session' });
    unmount();
  });

  it('renders the claudeAction preview with bash command and approves', () => {
    const onRespond = vi.fn();
    const { container, unmount } = mount(
      <ApprovalSheet
        requests={[{
          requestId: 'r-claude',
          turnId: 't',
          kind: 'claudeAction',
          params: {
            toolName: 'Bash',
            toolInput: { command: 'npm test' },
            cwd: '/proj'
          }
        }]}
        onRespond={onRespond}
      />
    );
    expect(container.textContent).toContain('Claude 想使用工具');
    expect(container.textContent).toContain('Bash');
    expect(container.textContent).toContain('npm test');
    act(() => { findButton(container, '允许本次').click(); });
    expect(onRespond).toHaveBeenCalledWith('r-claude', { decision: 'approved' });
    unmount();
  });

  it('renders an AskUserQuestion form and ships answers on submit', () => {
    const onRespond = vi.fn();
    const { container, unmount } = mount(
      <ApprovalSheet
        requests={[{
          requestId: 'r-q',
          turnId: 't',
          kind: 'claudeQuestion',
          params: {
            toolName: 'AskUserQuestion',
            toolInput: {
              questions: [{
                question: '偏好哪种配色？',
                header: '配色',
                multiSelect: false,
                options: [{ label: '暖色', description: '红橙调' }, { label: '冷色', description: '蓝青调' }]
              }]
            }
          }
        }]}
        onRespond={onRespond}
      />
    );
    expect(container.textContent).toContain('Claude 想请你选择');
    expect(container.textContent).toContain('偏好哪种配色？');
    // submit disabled until a choice is made
    const submit = findButton(container, '提交');
    expect(submit.disabled).toBe(true);
    act(() => { findOption(container, '暖色').click(); });
    expect(findButton(container, '提交').disabled).toBe(false);
    act(() => { findButton(container, '提交').click(); });
    expect(onRespond).toHaveBeenCalledWith('r-q', {
      decision: 'approved',
      answers: { '偏好哪种配色？': '暖色' }
    });
    unmount();
  });

  it('multiSelect question collects an array of labels', () => {
    const onRespond = vi.fn();
    const { container, unmount } = mount(
      <ApprovalSheet
        requests={[{
          requestId: 'r-m',
          turnId: 't',
          kind: 'claudeQuestion',
          params: {
            toolName: 'AskUserQuestion',
            toolInput: {
              questions: [{
                question: '包含哪些章节？',
                multiSelect: true,
                options: [{ label: '引言' }, { label: '结论' }, { label: '附录' }]
              }]
            }
          }
        }]}
        onRespond={onRespond}
      />
    );
    act(() => { findButton(container, '引言').click(); });
    act(() => { findButton(container, '结论').click(); });
    act(() => { findButton(container, '提交').click(); });
    expect(onRespond).toHaveBeenCalledWith('r-m', {
      decision: 'approved',
      answers: { '包含哪些章节？': ['引言', '结论'] }
    });
    unmount();
  });

  it('AskUserQuestion cancel ships denied', () => {
    const onRespond = vi.fn();
    const { container, unmount } = mount(
      <ApprovalSheet
        requests={[{
          requestId: 'r-c',
          turnId: 't',
          kind: 'claudeQuestion',
          params: { toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'x?', options: [{ label: 'a' }] }] } }
        }]}
        onRespond={onRespond}
      />
    );
    act(() => { findButton(container, '取消').click(); });
    expect(onRespond).toHaveBeenCalledWith('r-c', { decision: 'denied' });
    unmount();
  });

  it('ships denied / abort decisions', () => {
    const onRespond = vi.fn();
    const { container, unmount } = mount(
      <ApprovalSheet
        requests={[{ requestId: 'r', turnId: 't', kind: 'execCommand', params: { command: 'rm' } }]}
        onRespond={onRespond}
      />
    );
    act(() => { findButton(container, '拒绝').click(); });
    act(() => { findButton(container, '中止任务').click(); });
    expect(onRespond).toHaveBeenNthCalledWith(1, 'r', { decision: 'denied' });
    expect(onRespond).toHaveBeenNthCalledWith(2, 'r', { decision: 'abort' });
    unmount();
  });
});
