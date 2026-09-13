// One visual card for a multi-segment assistant turn. ChatPane groups
// consecutive messages sharing a turnId into one of these — Claude
// typically emits text → tool_use → text → tool_use → final_text and
// this card wraps the whole thing as one bubble.
//
// Layout (default, turn finished):
//
//   [Agent]
//   ┌────────────────────────────────────┐
//   │  ▸ 处理过程 · N 步                  │   collapsible toggle
//   │                                    │
//   │  Final answer content (prominent)  │   always visible
//   │                                    │
//   │  📋  ⋮                             │   copy / more
//   └────────────────────────────────────┘
//
// While the turn is running (any activity has status running/queued),
// the process section defaults to open so the user can watch progress.
// Once the turn finishes, the section auto-collapses; the user can then
// expand it to review what happened. Manual toggles override the auto
// behavior until the running flag flips again.

import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ActivityMessage } from './ActivityMessage.jsx';
import { MessageActions } from './MessageActions.jsx';
import { MessageContent } from './MessageContent.jsx';
import { PlanMessage } from './PlanMessage.jsx';

function deriveIsRunning(messages) {
  for (const message of messages) {
    if (message?.role !== 'activity') continue;
    const status = message?.status;
    if (status === 'running' || status === 'queued') return true;
  }
  return false;
}

function findConclusionIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'assistant') return i;
  }
  return -1;
}

function InlineSegment({ message, agent, now, onPreviewImage, onImplementPlan, onAdjustPlan }) {
  if (!message) return null;
  if (message.role === 'activity') {
    return <ActivityMessage message={message} now={now} onImplementPlan={onImplementPlan} turnPosition="middle" />;
  }
  if (message.role === 'plan' || message.role === 'plan_request') {
    return (
      <PlanMessage
        message={message}
        onPreviewImage={onPreviewImage}
        onImplementPlan={onImplementPlan}
        onAdjustPlan={onAdjustPlan}
      />
    );
  }
  // Assistant / user text segment — render bare content with a small
  // "thinking" wrapper so styles.css can dim/shrink the type. Calling
  // out the agent here would just duplicate the card author label.
  return (
    <div className="turn-thinking">
      <MessageContent content={message.content} onPreviewImage={onPreviewImage} isUser={false} />
    </div>
  );
}

export function TurnGroup({ messages, agent, now, onPreviewImage, onDeleteMessage, onImplementPlan, onAdjustPlan }) {
  const isRunning = deriveIsRunning(messages);
  const conclusionIdx = findConclusionIndex(messages);

  // Auto-derive default open state from running; user override clears
  // when running flips (mirrors the user's "运行中默认全部展开，完成后才折起"
  // spec, with manual toggles in between).
  const [override, setOverride] = useState(null);
  const wasRunningRef = useRef(isRunning);
  useEffect(() => {
    if (wasRunningRef.current !== isRunning) {
      setOverride(null);
      wasRunningRef.current = isRunning;
    }
  }, [isRunning]);
  const open = override !== null ? override : isRunning;

  // Fallback: a multi-message turn with no assistant text (e.g. all
  // activities). Render every message as a normal inline segment with
  // the conclusion slot empty.
  const hasConclusion = conclusionIdx >= 0;
  const processMessages = hasConclusion ? messages.slice(0, conclusionIdx) : messages;
  const conclusion = hasConclusion ? messages[conclusionIdx] : null;
  const trailing = hasConclusion ? messages.slice(conclusionIdx + 1) : [];
  const stepCount = processMessages.length + trailing.length;

  function toggle() {
    setOverride(!open);
  }

  return (
    <div className={`message-row is-assistant ${agent.accentClass || ''}`} data-turn-position="card">
      <div className="message-stack">
        <div className="turn-card">
          <div className="turn-card-head">
            <span className="turn-card-author">{agent.shortLabel}</span>
            {processMessages.length > 0 ? (
              <button
                type="button"
                className="turn-process-toggle"
                onClick={toggle}
                aria-expanded={open}
              >
                <ChevronDown size={14} className="turn-process-caret" />
                <span className="turn-process-label">
                  {isRunning ? '正在处理' : open ? '收起处理过程' : '查看处理过程'} · {stepCount} 步
                </span>
              </button>
            ) : null}
          </div>

          {processMessages.length > 0 && open ? (
            <div className="turn-process-body">
              {processMessages.map((message) => (
                <InlineSegment
                  key={message.id}
                  message={message}
                  agent={agent}
                  now={now}
                  onPreviewImage={onPreviewImage}
                  onImplementPlan={onImplementPlan}
                  onAdjustPlan={onAdjustPlan}
                />
              ))}
            </div>
          ) : null}

          {conclusion ? (
            <div className="turn-conclusion">
              <MessageContent
                content={conclusion.content}
                onPreviewImage={onPreviewImage}
                isUser={false}
              />
            </div>
          ) : null}

          {trailing.length > 0 && open ? (
            <div className="turn-trailing">
              {trailing.map((message) => (
                <InlineSegment
                  key={message.id}
                  message={message}
                  agent={agent}
                  now={now}
                  onPreviewImage={onPreviewImage}
                  onImplementPlan={onImplementPlan}
                  onAdjustPlan={onAdjustPlan}
                />
              ))}
            </div>
          ) : null}

          {conclusion ? (
            <MessageActions message={conclusion} onDeleteMessage={onDeleteMessage} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
