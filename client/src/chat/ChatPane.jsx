// Scrollable message list with smart scroll anchoring. Receives a pre-computed
// `agent` object (from agentMeta) so this component has no dependency on
// App-level helpers. Extracted from App.jsx (Batch B R11).
// Wrapped in a class-based error boundary (W11) so a single bad message can't
// crash the whole chat view.

import { Component, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { explicitChatJumpBehavior, isNearChatBottom, shouldFollowChatOutput } from '../chat-scroll.js';
import { markClientTurnLatency } from '../turn-latency.js';
import { AgentMark } from './AgentMark.jsx';
import { ChatMessage } from './ChatMessage.jsx';
import { TurnGroup } from './TurnGroup.jsx';

class ChatErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <section className="chat-pane">
          <div className="chat-error-boundary">
            <p>消息渲染出错，请刷新页面</p>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}

function ChatPaneInner({ messages, selectedSession, running, onPreviewImage, onDeleteMessage, onUseSuggestion, onImplementPlan, onAdjustPlan, agent }) {
  const bottomRef = useRef(null);
  const paneRef = useRef(null);
  // Track whether the user was pinned to the bottom *before* the next render
  // commits, so a one-frame layout flicker (e.g. message replacement) doesn't
  // count as "scrolled up".
  const pinnedBeforeUpdateRef = useRef(true);
  const lastSessionIdRef = useRef(selectedSession?.id || null);
  const [showJumpButton, setShowJumpButton] = useState(false);
  // Tracks whether we've already snapped to the bottom for the current
  // session. Reset on session change, set after the first non-empty render
  // gets a real scroll. Without this, a session whose messages load
  // asynchronously (handleSelectSession does setSelectedSession then awaits
  // an API call before setMessages) would land at the top forever — the
  // first paint after sessionId change happens with empty messages, and a
  // simple sessionId-equality guard would skip the second paint.
  const initialScrollDoneRef = useRef(false);

  // Capture pin state before each commit so the post-commit effect can decide
  // whether to follow the new content.
  pinnedBeforeUpdateRef.current = isNearChatBottom(paneRef.current);

  // Session swap: jump to bottom synchronously *before* paint so the user
  // never sees the chat starting at the top and animating downward. Runs on
  // every render until messages have loaded, then locks via the initial-
  // scroll flag so live updates don't keep snapping the user to the bottom.
  useLayoutEffect(() => {
    const sessionId = selectedSession?.id || null;
    if (sessionId !== lastSessionIdRef.current) {
      lastSessionIdRef.current = sessionId;
      initialScrollDoneRef.current = false;
      setShowJumpButton(false);
    }
    if (initialScrollDoneRef.current) return;
    if (!messages.length) return;
    const pane = paneRef.current;
    if (!pane) return;
    pane.scrollTop = pane.scrollHeight;
    initialScrollDoneRef.current = true;
  }, [selectedSession?.id, messages]);

  // Runs after React commits the updated chat DOM. This is closer to the user's
  // perceived first-text time than the WebSocket receive timestamp itself.
  useEffect(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== 'assistant' || !message?.turnId || !String(message.content || '').trim()) continue;
      markClientTurnLatency(message.turnId, 'firstTextApplied');
      break;
    }
  }, [messages]);

  // Live updates within the same session follow the bottom without restarting
  // a smooth-scroll animation on every streamed chunk. If the user scrolled up,
  // preserve their reading position and expose the explicit jump control.
  useEffect(() => {
    if (!initialScrollDoneRef.current) return;
    const follow = shouldFollowChatOutput({
      pinnedToBottom: isNearChatBottom(paneRef.current),
      pinnedBeforeUpdate: pinnedBeforeUpdateRef.current,
      force: false
    });
    if (follow) {
      const pane = paneRef.current;
      if (pane) {
        pane.scrollTop = pane.scrollHeight;
      }
      setShowJumpButton(false);
    } else if (running || messages.length) {
      setShowJumpButton(true);
    }
  }, [messages, running, selectedSession?.id]);

  // The empty-state and populated-state branches render different <section>
  // elements (paneRef swaps to a new DOM node on the boundary). Without
  // re-binding when that swap happens, the listener stays on the unmounted
  // empty-state node and the jump-to-latest button can never auto-dismiss.
  const hasMessages = messages.length > 0;
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return undefined;
    function handleScroll() {
      if (isNearChatBottom(pane)) {
        setShowJumpButton(false);
      }
    }
    pane.addEventListener('scroll', handleScroll, { passive: true });
    return () => pane.removeEventListener('scroll', handleScroll);
  }, [hasMessages]);

  function jumpToLatest() {
    const prefersReducedMotion = Boolean(
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    );
    bottomRef.current?.scrollIntoView({
      behavior: explicitChatJumpBehavior(prefersReducedMotion),
      block: 'end'
    });
    setShowJumpButton(false);
  }

  if (!messages.length) {
    return (
      <section ref={paneRef} className={`chat-pane empty-chat ${agent.accentClass}`}>
        <div className="empty-orbit">
          <AgentMark agent={agent} size={30} />
        </div>
        <h2>{selectedSession ? selectedSession.title : agent.emptyTitle}</h2>
        {selectedSession?.workingDir ? (
          <p className="empty-worktree">
            worktree · {selectedSession.workingBranch || selectedSession.workingDir}
          </p>
        ) : null}
        <p>{agent.emptyBody}</p>
        {agent.id === 'unknown' ? null : (
          <div className="empty-suggestions">
            {(agent.id === 'claude'
              ? ['审查当前改动', '继续上次开发', '生成实现计划']
              : ['解释当前项目', '修复报错', '生成图片']).map((item) => (
                <button type="button" key={item} onClick={() => onUseSuggestion?.(item)}>
                  {item}
                </button>
              ))}
          </div>
        )}
      </section>
    );
  }

  // Group consecutive same-turnId messages into turn groups. A group
  // with one message renders as a plain <ChatMessage>; a group with
  // multiple messages renders as a <TurnGroup> card (collapsible
  // process + prominent conclusion + single action row at the bottom).
  // Messages without a turnId become their own single-message group.
  //
  // User messages are ALWAYS standalone: the server tags a user message
  // with the same turnId as the assistant reply it kicks off, but a user
  // bubble must never be swept into the assistant's turn card — it is its
  // own right-aligned bubble above the reply.
  function buildTurnGroups(list) {
    const groups = [];
    let current = null;
    function flush() {
      if (current) {
        groups.push(current);
        current = null;
      }
    }
    for (const message of list) {
      const turnId = message?.turnId || null;
      if (!turnId || message?.role === 'user') {
        flush();
        groups.push({ key: message.id, turnId: null, messages: [message] });
        continue;
      }
      if (current && current.turnId === turnId) {
        current.messages.push(message);
        continue;
      }
      flush();
      current = { key: `${turnId}-${message.id}`, turnId, messages: [message] };
    }
    flush();
    return groups;
  }
  const turnGroups = buildTurnGroups(messages);

  return (
    <section ref={paneRef} className="chat-pane">
      {turnGroups.map((group) => {
        if (group.messages.length === 1) {
          return (
            <ChatMessage
              key={group.key}
              message={group.messages[0]}
              onPreviewImage={onPreviewImage}
              onDeleteMessage={onDeleteMessage}
              onImplementPlan={onImplementPlan}
              onAdjustPlan={onAdjustPlan}
              agent={agent}
              turnPosition="sole"
            />
          );
        }
        return (
          <TurnGroup
            key={group.key}
            messages={group.messages}
            agent={agent}
            now={Date.now()}
            onPreviewImage={onPreviewImage}
            onDeleteMessage={onDeleteMessage}
            onImplementPlan={onImplementPlan}
            onAdjustPlan={onAdjustPlan}
          />
        );
      })}
      {showJumpButton ? (
        <button type="button" className="jump-latest-button" onClick={jumpToLatest}>
          <span>{'\u65b0\u8f93\u51fa'}</span>
        </button>
      ) : null}
      <div ref={bottomRef} />
    </section>
  );
}

export function ChatPane(props) {
  return (
    <ChatErrorBoundary>
      <ChatPaneInner {...props} />
    </ChatErrorBoundary>
  );
}
