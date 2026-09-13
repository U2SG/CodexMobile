// Smoke for the visibility/online → forceReconnectNow path added in the
// 阶段 A PWA WebSocket resilience work. The hook is too entangled to
// unit-test directly, but jsdom is enough to assert two things that are
// easy to break silently:
//   1. Mounting the hook creates a WebSocket immediately.
//   2. Firing document.visibilitychange (visible) while the socket is not
//      OPEN constructs a second WebSocket — i.e. forceReconnectNow ran.

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN_KEY = 'codexmobile.deviceToken';

let constructed;
let container;
let root;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    this.closeCalls = 0;
    constructed.push(this);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    // Don't auto-fire onclose — useAppWebSocket may have already detached it
    // via forceReconnectNow. Tests assert on construction count, not handler
    // call counts.
  }

  send() {}
  addEventListener() {}
  removeEventListener() {}
}

let lastDesktopBridge;

function HookHost({ authenticated, onSetDesktopBridge, payloadMatchesCurrentConversation, pushApprovalRequest }) {
  // Lazy-import inside the component so vi.stubGlobal patches land before
  // the module evaluates anything that captures globals at import time.
  const { useAppWebSocket } = require('./useAppWebSocket.js');
  const wsRef = React.useRef(null);
  useAppWebSocket({
    authenticated,
    defaultStatus: { connected: false },
    wsRef,
    selectedProjectRef: { current: null },
    selectedSessionRef: { current: null },
    setConnectionState: () => {},
    setStatus: () => {},
    setSelectedSession: () => {},
    setSessionsByProject: () => {},
    setMessages: () => {},
    setProjects: () => {},
    setPinFolders: () => {},
    setPinnedSessions: () => {},
    setDesktopBridge: (next) => {
      const resolved = typeof next === 'function' ? next(lastDesktopBridge) : next;
      lastDesktopBridge = resolved;
      onSetDesktopBridge?.(resolved);
    },
    syncActiveRunsFromStatus: () => {},
    markRun: () => {},
    clearRun: () => {},
    markTurnCompleted: () => {},
    scheduleTurnRefresh: () => {},
    payloadMatchesCurrentConversation: payloadMatchesCurrentConversation || (() => false),
    upsertSessionInProject: (current) => current,
    upsertStatusMessage: (current) => current,
    upsertActivityMessage: (current) => current,
    upsertAssistantMessage: (current) => current,
    briefActivityLabel: () => '',
    pushApprovalRequest
  });
  return null;
}

beforeEach(() => {
  constructed = [];
  localStorage.setItem(TOKEN_KEY, 'smoke-token');
  vi.stubGlobal('WebSocket', FakeWebSocket);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('useAppWebSocket constructs a WebSocket on mount when authenticated', async () => {
  await act(async () => {
    root.render(<HookHost authenticated />);
  });
  expect(constructed).toHaveLength(1);
});

test('visibilitychange→visible forces a reconnect when current socket is not OPEN', async () => {
  await act(async () => {
    root.render(<HookHost authenticated />);
  });
  expect(constructed).toHaveLength(1);
  const first = constructed[0];
  // Socket is still CONNECTING (handshake never completed in the stub).
  expect(first.readyState).toBe(FakeWebSocket.CONNECTING);

  // Pretend the browser tab just came back to the foreground.
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible'
  });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });

  expect(constructed.length).toBeGreaterThanOrEqual(2);
  expect(first.closeCalls).toBe(1);
  // Handlers must be nulled before close so the stale onclose can't queue
  // another scheduleReconnect on top of the fresh connect.
  expect(first.onclose).toBeNull();
});

test('window online event forces a reconnect when current socket is not OPEN', async () => {
  await act(async () => {
    root.render(<HookHost authenticated />);
  });
  expect(constructed).toHaveLength(1);

  await act(async () => {
    window.dispatchEvent(new Event('online'));
  });

  expect(constructed.length).toBeGreaterThanOrEqual(2);
});

test('visibilitychange does NOT reconnect when the current socket is already OPEN', async () => {
  await act(async () => {
    root.render(<HookHost authenticated />);
  });
  expect(constructed).toHaveLength(1);
  constructed[0].readyState = FakeWebSocket.OPEN;

  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible'
  });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });

  expect(constructed).toHaveLength(1);
});

test('desktop-bridge-changed WS frame routes to setDesktopBridge', async () => {
  const observed = [];
  await act(async () => {
    root.render(
      <HookHost
        authenticated
        onSetDesktopBridge={(value) => observed.push(value)}
      />
    );
  });
  expect(constructed).toHaveLength(1);
  const ws = constructed[0];

  const newStatus = {
    connected: true,
    mode: 'desktop-ipc',
    reason: null,
    socketPath: '\\\\.\\pipe\\codex-ipc',
    checkedAt: 1234,
    openThreadIds: ['c-abc', 'c-def']
  };

  await act(async () => {
    ws.onmessage?.({ data: JSON.stringify({ type: 'desktop-bridge-changed', status: newStatus }) });
  });

  expect(observed).toContainEqual(newStatus);
});

test('approval-request is surfaced even when it belongs to another selected conversation', async () => {
  const approvals = [];
  await act(async () => {
    root.render(
      <HookHost
        authenticated
        payloadMatchesCurrentConversation={() => false}
        pushApprovalRequest={(request) => approvals.push(request)}
      />
    );
  });
  const ws = constructed[0];
  const request = {
    type: 'approval-request',
    requestId: 'req-background',
    sessionId: 'session-background',
    turnId: 'turn-background',
    kind: 'execCommand',
    params: { command: 'npm test' }
  };

  await act(async () => {
    ws.onmessage?.({ data: JSON.stringify(request) });
  });

  expect(approvals).toContainEqual(request);
});
