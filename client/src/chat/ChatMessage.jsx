// Single chat turn bubble. Dispatches to ActivityMessage for role='activity',
// PlanMessage for role='plan'|'plan_request', otherwise renders user/assistant
// content via MessageContent with a copy/delete action row.
//
// ChatPane decides which `turnPosition` ('sole' / 'first' / 'middle' / 'last')
// each row carries within its turn group; ChatMessage uses it to gate the
// author label (first/sole only) and action row (last/sole only). Multi-
// segment assistant turns are normally rendered by TurnGroup, not by a chain
// of ChatMessages — but the position-based fallback keeps the older
// presentation usable when there's no TurnGroup wrapping.

import { formatTime } from '../format-time.js';
import { ActivityMessage } from './ActivityMessage.jsx';
import { MessageActions } from './MessageActions.jsx';
import { MessageContent } from './MessageContent.jsx';
import { PlanMessage } from './PlanMessage.jsx';

export function ChatMessage({
  message,
  now,
  onPreviewImage,
  onDeleteMessage,
  onImplementPlan,
  onAdjustPlan,
  agent,
  turnPosition = 'sole'
}) {
  if (message.role === 'activity') {
    return <ActivityMessage message={message} now={now} onImplementPlan={onImplementPlan} turnPosition={turnPosition} />;
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
  const isUser = message.role === 'user';
  const canAct = message.role === 'user' || message.role === 'assistant';
  const roleLabel = isUser ? '你' : agent.shortLabel;
  const isFirstInTurn = turnPosition === 'sole' || turnPosition === 'first';
  const isLastInTurn = turnPosition === 'sole' || turnPosition === 'last';
  const renderActions = canAct && isLastInTurn;
  const renderAuthor = isFirstInTurn;

  return (
    <div
      className={`message-row ${isUser ? 'is-user' : 'is-assistant'} ${!isUser ? agent.accentClass : ''}`}
      data-turn-position={turnPosition}
    >
      <div className="message-stack">
        {renderAuthor ? <div className="message-author">{roleLabel}</div> : null}
        <div className="message-bubble">
          <MessageContent content={message.content} onPreviewImage={onPreviewImage} isUser={isUser} />
          {message.timestamp ? <time>{formatTime(message.timestamp)}</time> : null}
        </div>
        {renderActions ? <MessageActions message={message} onDeleteMessage={onDeleteMessage} /> : null}
      </div>
    </div>
  );
}
