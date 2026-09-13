import { Check, CheckCircle2, ChevronDown, Copy, CornerDownLeft, Play, SendHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatTime } from '../format-time.js';
import { copyTextToClipboard } from '../utils/clipboard.js';
import { MessageContent } from './MessageContent.jsx';

export function PlanMessage({ message, onPreviewImage, onImplementPlan, onAdjustPlan }) {
  if (message.role === 'plan_request') {
    return (
      <PlanRequestMessage
        message={message}
        onImplementPlan={onImplementPlan}
        onAdjustPlan={onAdjustPlan}
      />
    );
  }
  return <PlanCard message={message} onPreviewImage={onPreviewImage} />;
}

function PlanCard({ message, onPreviewImage }) {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const copiedTimerRef = useRef(null);
  const title = message.title || '计划';

  useEffect(() => () => {
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
  }, []);

  async function handleCopy() {
    const ok = await copyTextToClipboard(message.content);
    if (!ok) {
      window.alert('复制失败');
      return;
    }
    setCopied(true);
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className="message-row is-plan">
      <article className={`plan-card ${collapsed ? 'is-collapsed' : ''}`}>
        <header className="plan-card-header">
          <button
            type="button"
            className="plan-card-toggle"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            <ChevronDown className={`plan-card-chevron ${collapsed ? '' : 'is-open'}`} size={15} />
            <span className="plan-card-title">{title}</span>
          </button>
          <div className="plan-card-actions">
            <button type="button" className="plan-icon-button" onClick={handleCopy} aria-label="复制计划">
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
        </header>
        {collapsed ? null : (
          <>
            <div className="plan-card-content">
              <MessageContent content={message.content} onPreviewImage={onPreviewImage} />
            </div>
            {message.timestamp ? <time>{formatTime(message.timestamp)}</time> : null}
          </>
        )}
      </article>
    </div>
  );
}

function PlanRequestMessage({ message, onImplementPlan, onAdjustPlan }) {
  const [adjustment, setAdjustment] = useState('');
  const [submittingImplement, setSubmittingImplement] = useState(false);
  const [submittingAdjust, setSubmittingAdjust] = useState(false);
  const [completed, setCompleted] = useState(Boolean(message.planImplementation?.completed || message.status === 'completed'));
  const inputRef = useRef(null);
  const plan = message.planImplementation || {};
  const implementDisabled = completed || submittingImplement || !onImplementPlan;
  const adjustDisabled = submittingAdjust || !onAdjustPlan || !adjustment.trim();

  useEffect(() => {
    setCompleted(Boolean(message.planImplementation?.completed || message.status === 'completed'));
  }, [message.planImplementation?.completed, message.status]);

  if (completed) {
    return null;
  }

  async function handleImplement() {
    if (implementDisabled) {
      return;
    }
    setSubmittingImplement(true);
    const ok = await onImplementPlan(plan);
    setSubmittingImplement(false);
    if (ok) {
      setCompleted(true);
    }
  }

  async function handleAdjust(event) {
    event.preventDefault();
    const text = adjustment.trim();
    if (!text || !onAdjustPlan) {
      return;
    }
    setSubmittingAdjust(true);
    const ok = await onAdjustPlan(text, plan);
    setSubmittingAdjust(false);
    if (ok) {
      setAdjustment('');
      setCompleted(true);
    }
  }

  return (
    <div className="message-row is-plan-request">
      <section className={`plan-request-panel ${completed ? 'is-completed' : ''}`}>
        <div className="plan-request-title">
          {completed ? <CheckCircle2 size={15} /> : <CornerDownLeft size={15} />}
          <span>{completed ? '计划已确认执行' : '实施此计划?'}</span>
        </div>
        <button
          type="button"
          className="plan-request-option is-primary"
          disabled={implementDisabled}
          onClick={handleImplement}
        >
          <span className="plan-option-index">1.</span>
          {completed ? <CheckCircle2 size={16} /> : <Play size={16} />}
          <strong>{completed ? '已发送执行请求' : submittingImplement ? '发送中' : '是，实施此计划'}</strong>
        </button>
        <form className="plan-request-option is-adjust" onSubmit={handleAdjust}>
          <button
            type="button"
            className="plan-option-index-button"
            onClick={() => inputRef.current?.focus()}
            aria-label="填写调整要求"
          >
            2.
          </button>
          <input
            ref={inputRef}
            value={adjustment}
            onChange={(event) => setAdjustment(event.target.value)}
            placeholder="否，请告知 Codex 如何调整"
            disabled={submittingAdjust}
          />
          <button type="submit" className="plan-adjust-submit" disabled={adjustDisabled} aria-label="提交调整">
            <SendHorizontal size={15} />
          </button>
        </form>
      </section>
    </div>
  );
}
