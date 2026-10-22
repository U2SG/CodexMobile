// Smoke coverage for the live channel hook: it opens /api/events on mount,
// routes frames to the right setters, and refetches state when the server
// says its cursor fell out of the log.

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useAppEventStream } from './useAppEventStream.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN_KEY = 'codexmobile.deviceToken';
let container;
let root;
let streams;
let requests;

function fakeFetch(url, init = {}) {
  requests.push(url);
  if (url === '/api/events') {
    let controller;
    const body = new ReadableStream({ start(c) { controller = c; } });
    init.signal?.addEventListener('abort', () => {
      try { controller.error(new Error('aborted')); } catch { /* closed */ }
    });
    streams.push({ push: (text) => controller.enqueue(new TextEncoder().encode(text)) });
    return Promise.resolve(new Response(body, { status: 200 }));
  }
  const json = url === '/api/projects' ? { projects: [{ id: 'p1' }] } : { messages: [{ id: 'snapshot' }], sessions: [] };
  const reply = () => new Response(JSON.stringify(json), { status: 200 });
  if (String(url).startsWith('/api/sessions/') && messagesGate) {
    return messagesGate.then(reply);
  }
  return Promise.resolve(reply());
}

let messagesGate = null;

function HookHost({ onSetDesktopBridge = () => {}, onSetProjects = () => {}, onSetMessages = () => {}, pushApprovalRequest = () => {}, selectedSession = null }) {
  useAppEventStream({
    authenticated: true,
    defaultStatus: { connected: false },
    selectedProjectRef: { current: null },
    selectedSessionRef: { current: selectedSession },
    sessionsByProjectRef: { current: {} },
    setConnectionState: () => {},
    setStatus: () => {},
    setSelectedSession: () => {},
    setSessionsByProject: () => {},
    setMessages: (value) => onSetMessages(value),
    setProjects: onSetProjects,
    setPinFolders: () => {},
    setPinnedSessions: () => {},
    setDesktopBridge: onSetDesktopBridge,
    syncActiveRunsFromStatus: () => {},
    markRun: () => {},
    clearRun: () => {},
    markTurnCompleted: () => {},
    scheduleTurnRefresh: () => {},
    payloadMatchesCurrentConversation: () => false,
    upsertSessionInProject: (current) => current,
    upsertStatusMessage: (current) => current,
    upsertActivityMessage: (current) => current,
    upsertAssistantMessage: (current) => current,
    briefActivityLabel: () => '',
    pushApprovalRequest,
    dropApprovalRequest: () => {}
  });
  return null;
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

beforeEach(() => {
  streams = [];
  messagesGate = null;
  requests = [];
  localStorage.setItem(TOKEN_KEY, 'smoke-token');
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('opens the event stream on mount and routes frames to their setters', async () => {
  const bridges = [];
  const approvals = [];
  await act(async () => {
    root.render(<HookHost onSetDesktopBridge={(v) => bridges.push(v)} pushApprovalRequest={(r) => approvals.push(r)} />);
  });
  await settle();
  expect(streams).toHaveLength(1);
  const status = { connected: true, mode: 'desktop-ipc' };
  const approval = { type: 'approval-request', requestId: 'r1', turnId: 't1', kind: 'execCommand' };
  streams[0].push(
    'event: resume\ndata: {"status":"fresh"}\n\n'
    + `id: e:1\ndata: ${JSON.stringify({ type: 'desktop-bridge-changed', status })}\n\n`
    + `id: e:2\ndata: ${JSON.stringify(approval)}\n\n`
  );
  await settle();
  expect(bridges).toContainEqual(status);
  expect(approvals).toContainEqual(approval);
});

test('a gap refetches projects instead of trusting stale state', async () => {
  const projects = [];
  await act(async () => {
    root.render(<HookHost onSetProjects={(v) => projects.push(v)} />);
  });
  await settle();
  streams[0].push('event: resume\ndata: {"status":"gap"}\n\n');
  await settle();
  expect(requests).toContain('/api/projects');
  expect(projects.at(-1)).toEqual([{ id: 'p1' }]);
});

test('frames that arrive during a gap refetch are applied after the snapshot, not undone by it', async () => {
  let openGate;
  messagesGate = new Promise((resolve) => { openGate = resolve; });
  const order = [];
  await act(async () => {
    root.render(
      <HookHost
        selectedSession={{ id: 's1' }}
        onSetMessages={(value) => order.push(typeof value === 'function' ? 'update' : `snapshot:${value[0]?.id}`)}
        onSetDesktopBridge={() => order.push('bridge')}
      />
    );
  });
  await settle();
  streams[0].push(
    'event: resume\ndata: {"status":"gap","cursor":"e:9"}\n\n'
    + `id: e:10\ndata: ${JSON.stringify({ type: 'desktop-bridge-changed', status: { connected: true } })}\n\n`
  );
  await settle();
  expect(order).toEqual([]);
  openGate();
  await settle();
  expect(order).toEqual(['snapshot:snapshot', 'bridge']);
});
