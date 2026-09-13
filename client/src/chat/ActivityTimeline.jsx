import { BookOpenCheck, Bot, CheckCircle2, ChevronDown, FileText, Pencil, Play, Search, SquareTerminal } from 'lucide-react';
import { useState } from 'react';
import { ActivityFileSummary } from './ActivityFileSummary.jsx';
import {
  activityBodyItemsForDisplay,
  activityDetailText,
  activityStepDetailTitle,
  isSkillActivityStep
} from './activity-timeline-model.js';
import { MessageContent as MarkdownContent } from './MessageContent.jsx';

function commandCardTitle(step) {
  const label = String(step.label || '').trim();
  if (label && !/^\$\s/.test(label) && label.length <= 140) {
    return label;
  }
  return activityStepDetailTitle(step);
}

function toolChipName(step) {
  const raw = String(step.toolName || '').trim();
  if (raw) {
    if (/^bash$/i.test(raw)) return 'Bash';
    if (/^powershell$/i.test(raw)) return 'PowerShell';
    return raw;
  }
  if (step.type === 'search' || step.type === 'web_search') return 'Search';
  if (step.type === 'explore') return 'Read';
  if (step.type === 'edit') return 'Edit';
  if (step.type === 'browser') return 'Browser';
  if (step.type === 'command' || step.command) return 'Shell';
  return '';
}

export function ActivityTimeline({ timeline, fileSummary, onImplementPlan }) {
  if (!timeline?.length && !fileSummary) {
    return null;
  }
  return (
    <div className="activity-timeline" aria-label="任务进度">
      {(timeline || []).map((item) => (
        <ActivityTimelineItem key={item.id} item={item} onImplementPlan={onImplementPlan} />
      ))}
      {fileSummary ? <ActivityFileSummary summary={fileSummary} /> : null}
    </div>
  );
}

function ActivityTimelineItem({ item, onImplementPlan }) {
  if (item.type === 'text') {
    return (
      <MarkdownContent
        className="message-content activity-markdown activity-text"
        content={item.text}
      />
    );
  }
  if (item.type === 'live') {
    return (
      <div className={`activity-live is-${item.liveType || 'step'} ${item.status === 'running' ? 'is-running' : ''}`}>
        <span className="activity-live-dot" />
        <span>{item.text}</span>
      </div>
    );
  }
  if (item.type === 'divider') {
    return (
      <div className="activity-divider">
        <span>{item.text}</span>
      </div>
    );
  }
  if (item.metaType === 'subagent') {
    return <SubagentActivityBlock item={item} />;
  }
  return <MetaActivityBlock item={item} onImplementPlan={onImplementPlan} />;
}

function MetaActivityBlock({ item, onImplementPlan }) {
  const visibleItems = item.type === 'metaBurst' ? item.visibleItems || [] : item.items || [];
  const overflowItems = item.type === 'metaBurst' ? item.overflowItems || [] : [];
  const allItems = item.items || visibleItems;
  const running = allItems.some((step) => step.status === 'running' || step.status === 'queued');
  const { visibleBodyItems, overflowBodyItems } = activityBodyItemsForDisplay(visibleItems, overflowItems);
  const planImplementationStep = [...visibleBodyItems, ...overflowBodyItems].find((step) => step.planImplementation);
  if (planImplementationStep) {
    return (
      <PlanImplementationBlock
        item={item}
        step={planImplementationStep}
        onImplementPlan={onImplementPlan}
      />
    );
  }

  if (!visibleBodyItems.length && !overflowBodyItems.length) {
    return (
      <div className={`activity-meta ${running ? 'is-running' : ''}`}>
        <div className="activity-meta-summary">
          {activityMetaIcon(item)}
          <span>{item.title}</span>
        </div>
      </div>
    );
  }

  return (
    <details className={`activity-meta ${running ? 'is-running' : ''}`}>
      <summary className="activity-meta-summary">
        {activityMetaIcon(item)}
        <span>{item.title}</span>
      </summary>
      <div className="activity-meta-body">
        {visibleBodyItems.map((step) => (
          <ActivityStepDetail key={step.id} step={step} />
        ))}
        {overflowBodyItems.length ? (
          <details className="activity-overflow">
            <summary>还有 {overflowBodyItems.length} 条过程</summary>
            <div className="activity-meta-body">
              {overflowBodyItems.map((step) => (
                <ActivityStepDetail key={step.id} step={step} />
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </details>
  );
}

function PlanImplementationBlock({ item, step, onImplementPlan }) {
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const plan = step.planImplementation || {};
  const completed = Boolean(plan.completed || submitted);
  const disabled = completed || submitting || !onImplementPlan;

  async function handleClick() {
    if (disabled) {
      return;
    }
    setSubmitting(true);
    const ok = await onImplementPlan(plan);
    setSubmitting(false);
    if (ok) {
      setSubmitted(true);
    }
  }

  return (
    <div className={`activity-meta activity-plan-confirmation ${completed ? 'is-completed' : ''}`}>
      <div className="activity-meta-summary">
        {completed ? <CheckCircle2 size={13} strokeWidth={1.9} /> : activityMetaIcon(item)}
        <span>{completed ? '计划已确认执行' : activityStepDetailTitle(step)}</span>
      </div>
      <div className="activity-plan-confirmation-body">
        <button
          type="button"
          className="activity-plan-confirmation-button"
          disabled={disabled}
          onClick={handleClick}
        >
          {completed ? <CheckCircle2 size={14} /> : <Play size={14} />}
          <span>{completed ? '已发送' : submitting ? '发送中' : '确认执行计划'}</span>
        </button>
      </div>
    </div>
  );
}

function ActivityStepDetail({ step }) {
  const detail = activityDetailText(step);
  const isCommand = step.type === 'command' || Boolean(step.command);
  if (isCommand) {
    const command = step.command || detail;
    const output = String(step.output || step.error || '').trim();
    const failed = step.status === 'failed';
    const running = step.status === 'running';
    const title = commandCardTitle(step);
    const chip = toolChipName(step);
    const statusText = failed && step.exitCode !== undefined && step.exitCode !== null
      ? `退出码 ${step.exitCode}`
      : failed
        ? '失败'
        : running
          ? '运行中'
          : '成功';
    return (
      <details className={`activity-command-card ${failed ? 'is-failed' : ''} ${running ? 'is-running' : ''}`}>
        <summary className="activity-command-header">
          {chip ? (
            <span className="activity-command-chip">
              {activityStepIcon(step)}
              <span>{chip}</span>
            </span>
          ) : activityStepIcon(step)}
          {title ? <strong className="activity-command-title">{title}</strong> : null}
          <ChevronDown size={14} className="activity-command-chevron" />
        </summary>
        <div className="activity-command-body-wrap">
          {command ? <pre className="activity-command-body"><code>{command}</code></pre> : null}
          {output ? (
            <pre className="activity-command-output-pre"><code>{output}</code></pre>
          ) : null}
          <div className="activity-command-status">{statusText}</div>
        </div>
      </details>
    );
  }

  return (
    <div className="activity-meta-line">
      <MarkdownContent
        className="message-content activity-markdown activity-meta-label"
        content={step.label}
      />
      <MarkdownContent
        className="message-content activity-markdown activity-meta-detail"
        content={detail}
      />
    </div>
  );
}

function SubagentActivityBlock({ item }) {
  const items = item.items || [];
  const agents = items.flatMap((step) => (Array.isArray(step.subAgents) ? step.subAgents : []));
  const title = items[0]?.label || item.title || `${agents.length || 1} 个后台智能体（使用 @ 标记智能体）`;
  return (
    <details className="activity-meta activity-subagents">
      <summary className="activity-meta-summary">
        <Bot size={13} />
        <span>{title}</span>
      </summary>
      <div className="activity-subagent-list">
        {agents.length ? agents.map((agent) => (
          <div key={agent.threadId || `${agent.nickname}-${agent.role}`} className="activity-subagent-row">
            <span>
              <strong>{agent.nickname || agent.threadId || '子代理'}</strong>
              {agent.role ? <small>({agent.role})</small> : null}
              <em>{agent.statusText || '打开'}</em>
            </span>
          </div>
        )) : (
          <div className="activity-subagent-row">
            <span><strong>{item.title}</strong></span>
          </div>
        )}
      </div>
    </details>
  );
}

function activityMetaIcon(item) {
  if ((item.items || []).some((step) => isSkillActivityStep(step))) {
    return <BookOpenCheck size={13} strokeWidth={1.9} />;
  }
  if (item.metaType === 'command') {
    return <SquareTerminal size={13} strokeWidth={1.9} />;
  }
  if (item.metaType === 'edit') {
    return <Pencil size={13} />;
  }
  if (item.metaType === 'search' || item.metaType === 'web_search') {
    return <Search size={13} />;
  }
  if (item.metaType === 'subagent') {
    return <Bot size={13} />;
  }
  return <FileText size={13} />;
}

function activityStepIcon(step) {
  if (isSkillActivityStep(step)) {
    return <BookOpenCheck size={13} strokeWidth={1.9} />;
  }
  if (step.type === 'command') {
    return <SquareTerminal size={13} strokeWidth={1.9} />;
  }
  if (step.type === 'search' || step.type === 'web_search') {
    return <Search size={13} />;
  }
  return <FileText size={13} />;
}
