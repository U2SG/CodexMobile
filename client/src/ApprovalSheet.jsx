// ApprovalSheet — bottom sheet that surfaces a Codex `approval-request`
// frame to the user and ships an `approval-response` back over the same
// WebSocket. Only mounts when the server actually asks; when the queue
// drains the sheet auto-dismisses.
//
// The server can ask four shapes (see ServerRequest in the protocol):
//   execCommand   — running a shell command (sandbox escape / network)
//   fileChange    — applying a patch to a file
//   permissions   — bumping the permission profile
//   toolInput     — a tool wants to ask the user a question
//
// We keep the rendering deliberately plain: command/diff/permission preview
// + four decisive buttons (允许 / 总是允许 / 拒绝 / 中止). The richer per-
// kind affordances (per-file accept/reject for patches, granular permission
// toggles) can land later — the protocol allows us to pass extra payload up
// at decision time without changing this contract.

import { useMemo, useState } from 'react';

function FieldRow({ label, children }) {
  return (
    <div className="approval-sheet__row">
      <div className="approval-sheet__label">{label}</div>
      <div className="approval-sheet__value">{children}</div>
    </div>
  );
}

function ExecPreview({ params }) {
  const command = params?.command || '';
  const cwd = params?.cwd || '';
  const reason = params?.reason || '';
  return (
    <div className="approval-sheet__exec">
      {reason ? <FieldRow label="原因">{reason}</FieldRow> : null}
      <FieldRow label="命令">
        <pre className="approval-sheet__code">{command}</pre>
      </FieldRow>
      {cwd ? <FieldRow label="目录">{cwd}</FieldRow> : null}
    </div>
  );
}

function FileChangePreview({ params }) {
  const fileChanges = params?.fileChanges || {};
  const reason = params?.reason || '';
  const grantRoot = params?.grantRoot || '';
  const paths = Object.keys(fileChanges);
  return (
    <div className="approval-sheet__patch">
      {reason ? <FieldRow label="原因">{reason}</FieldRow> : null}
      {grantRoot ? <FieldRow label="写入根目录">{grantRoot}</FieldRow> : null}
      <FieldRow label={`文件 (${paths.length})`}>
        <ul className="approval-sheet__file-list">
          {paths.map((p) => (
            <li key={p}>
              <code>{p}</code>
            </li>
          ))}
        </ul>
      </FieldRow>
    </div>
  );
}

function PermissionsPreview({ params }) {
  const profile = params?.permissions || {};
  const reason = params?.reason || '';
  return (
    <div className="approval-sheet__perm">
      {reason ? <FieldRow label="原因">{reason}</FieldRow> : null}
      <FieldRow label="权限配置">
        <pre className="approval-sheet__code">{JSON.stringify(profile, null, 2)}</pre>
      </FieldRow>
    </div>
  );
}

function ToolInputPreview({ params }) {
  const prompt = params?.prompt || params?.question || params?.tool || '';
  return (
    <FieldRow label="工具问询">
      <pre className="approval-sheet__code">{typeof prompt === 'string' ? prompt : JSON.stringify(prompt, null, 2)}</pre>
    </FieldRow>
  );
}

function ClaudeActionPreview({ params }) {
  const toolName = params?.toolName || '';
  const toolInput = params?.toolInput || {};
  const cwd = params?.cwd || '';
  // Show the bash command up front when present — it's the highest-signal
  // single field across the common tools. Otherwise pretty-print the full
  // input.
  const command = typeof toolInput?.command === 'string' ? toolInput.command : '';
  const filePath = typeof toolInput?.file_path === 'string' ? toolInput.file_path : '';
  return (
    <div className="approval-sheet__exec">
      <FieldRow label="工具">{toolName || '(unknown)'}</FieldRow>
      {command ? (
        <FieldRow label="命令">
          <pre className="approval-sheet__code">{command}</pre>
        </FieldRow>
      ) : null}
      {filePath ? <FieldRow label="文件">{filePath}</FieldRow> : null}
      {!command && !filePath ? (
        <FieldRow label="参数">
          <pre className="approval-sheet__code">{JSON.stringify(toolInput, null, 2)}</pre>
        </FieldRow>
      ) : null}
      {cwd ? <FieldRow label="目录">{cwd}</FieldRow> : null}
    </div>
  );
}

// AskUserQuestion surfaces as a form, not an allow/deny preview. Each
// question renders its options as selectable chips (single-select replaces,
// multiSelect toggles). On submit we ship `answers` keyed by question text →
// chosen label (string for single, array for multiSelect) — the shape the
// PreToolUse hook injects back as the tool result.
function ClaudeQuestionForm({ params, onSubmit, onCancel }) {
  const questions = useMemo(
    () => (Array.isArray(params?.toolInput?.questions) ? params.toolInput.questions : []),
    [params]
  );
  const [selections, setSelections] = useState(() => questions.map(() => []));

  const toggle = (qi, label, multi) => {
    setSelections((prev) => {
      const next = prev.slice();
      const cur = next[qi] || [];
      if (multi) {
        next[qi] = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
      } else {
        next[qi] = [label];
      }
      return next;
    });
  };

  const complete = questions.length > 0 && questions.every((_, i) => (selections[i] || []).length > 0);

  const submit = () => {
    const answers = {};
    questions.forEach((q, i) => {
      const chosen = selections[i] || [];
      answers[q.question] = q.multiSelect ? chosen : (chosen[0] || '');
    });
    onSubmit(answers);
  };

  return (
    <div className="approval-sheet__question">
      {questions.map((q, qi) => (
        <div key={qi} className="approval-sheet__q">
          {q.header ? <div className="approval-sheet__q-header">{q.header}</div> : null}
          <div className="approval-sheet__q-text">{q.question}</div>
          <div className="approval-sheet__q-options">
            {(q.options || []).map((opt, oi) => {
              const selected = (selections[qi] || []).includes(opt.label);
              return (
                <button
                  type="button"
                  key={oi}
                  className={`approval-sheet__option${selected ? ' approval-sheet__option--selected' : ''}`}
                  aria-pressed={selected}
                  onClick={() => toggle(qi, opt.label, q.multiSelect)}
                >
                  <span className="approval-sheet__option-label">{opt.label}</span>
                  {opt.description ? (
                    <span className="approval-sheet__option-desc">{opt.description}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {q.multiSelect ? <div className="approval-sheet__q-hint">可多选</div> : null}
        </div>
      ))}
      <div className="approval-sheet__buttons">
        <button
          type="button"
          className="approval-sheet__btn approval-sheet__btn--deny"
          onClick={onCancel}
        >取消</button>
        <button
          type="button"
          className="approval-sheet__btn approval-sheet__btn--once"
          disabled={!complete}
          onClick={submit}
        >提交</button>
      </div>
    </div>
  );
}

function previewFor(kind, params) {
  switch (kind) {
    case 'execCommand': return <ExecPreview params={params} />;
    case 'fileChange': return <FileChangePreview params={params} />;
    case 'permissions': return <PermissionsPreview params={params} />;
    case 'toolInput': return <ToolInputPreview params={params} />;
    case 'claudeAction': return <ClaudeActionPreview params={params} />;
    default:
      return (
        <FieldRow label="详情">
          <pre className="approval-sheet__code">{JSON.stringify(params, null, 2)}</pre>
        </FieldRow>
      );
  }
}

function titleFor(kind) {
  switch (kind) {
    case 'execCommand': return 'Codex 想执行命令';
    case 'fileChange': return 'Codex 想修改文件';
    case 'permissions': return 'Codex 请求扩大权限';
    case 'toolInput': return 'Codex 工具需要回答';
    case 'mcpElicitation': return 'MCP 服务需要确认';
    case 'claudeAction': return 'Claude 想使用工具';
    case 'claudeQuestion': return 'Claude 想请你选择';
    default: return '助手请求确认';
  }
}

export default function ApprovalSheet({ requests, onRespond }) {
  const head = requests[0];
  const remaining = useMemo(() => requests.length - 1, [requests.length]);
  if (!head) return null;

  const send = (decision) => onRespond(head.requestId, decision);

  if (head.kind === 'claudeQuestion') {
    return (
      <div className="approval-sheet" role="dialog" aria-modal="true">
        <div className="approval-sheet__backdrop" onClick={() => null} />
        <div className="approval-sheet__panel">
          <div className="approval-sheet__header">
            <h3>{titleFor(head.kind)}</h3>
            {remaining > 0 ? (
              <span className="approval-sheet__queue">还有 {remaining} 个待确认</span>
            ) : null}
          </div>
          <div className="approval-sheet__body">
            <ClaudeQuestionForm
              key={head.requestId}
              params={head.params}
              onSubmit={(answers) => onRespond(head.requestId, { decision: 'approved', answers })}
              onCancel={() => send({ decision: 'denied' })}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="approval-sheet" role="dialog" aria-modal="true">
      <div className="approval-sheet__backdrop" onClick={() => null} />
      <div className="approval-sheet__panel">
        <div className="approval-sheet__header">
          <h3>{titleFor(head.kind)}</h3>
          {remaining > 0 ? (
            <span className="approval-sheet__queue">还有 {remaining} 个待确认</span>
          ) : null}
        </div>
        <div className="approval-sheet__body">{previewFor(head.kind, head.params)}</div>
        <div className="approval-sheet__buttons">
          <button type="button" className="approval-sheet__btn approval-sheet__btn--deny" onClick={() => send({ decision: 'denied' })}>拒绝</button>
          <button type="button" className="approval-sheet__btn approval-sheet__btn--abort" onClick={() => send({ decision: 'abort' })}>中止任务</button>
          <button type="button" className="approval-sheet__btn approval-sheet__btn--once" onClick={() => send({ decision: 'approved' })}>允许本次</button>
          <button type="button" className="approval-sheet__btn approval-sheet__btn--session" onClick={() => send({ decision: 'approved_for_session' })}>本会话总是允许</button>
        </div>
      </div>
    </div>
  );
}
