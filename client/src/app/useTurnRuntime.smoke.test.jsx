import React, { useRef, useState } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useTurnRuntime } from './useTurnRuntime.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;
let latest;

function RuntimeHost() {
  const selectedSessionRef = useRef({ id: 'session-1' });
  const [messages, setMessages] = useState([
    { id: 'activity-1', role: 'activity', status: 'running', turnId: 'turn-1', sessionId: 'session-1' }
  ]);
  const [selectedSession, setSelectedSession] = useState({ id: 'session-1' });
  const [sessionsByProject, setSessionsByProject] = useState({});
  const runtime = useTurnRuntime({
    selectedSessionRef,
    setMessages,
    setSelectedSession,
    setSessionsByProject
  });
  latest = { ...runtime, messages, selectedSession, sessionsByProject };
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-13T05:00:00Z'));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  latest = null;
  vi.useRealTimers();
});

test('authoritative empty activeRuns clears stale running keys and activity after local grace expires', async () => {
  await act(async () => root.render(<RuntimeHost />));

  await act(async () => {
    latest.markRun({ turnId: 'turn-1', sessionId: 'session-1' });
  });
  expect(latest.runningById).toMatchObject({ 'turn-1': true, 'session-1': true });

  await act(async () => {
    vi.advanceTimersByTime(16_000);
    latest.syncActiveRunsFromStatus({ connected: true, activeRuns: [] });
  });

  expect(latest.runningById).toEqual({});
  expect(latest.messages.some((message) => message.role === 'activity' && message.status === 'running')).toBe(false);
});

test('empty activeRuns keeps a just-started optimistic run during the short local grace window', async () => {
  await act(async () => root.render(<RuntimeHost />));

  await act(async () => {
    latest.markRun({ turnId: 'turn-1', sessionId: 'session-1' });
    latest.syncActiveRunsFromStatus({ connected: true, activeRuns: [] });
  });

  expect(latest.runningById).toMatchObject({ 'turn-1': true, 'session-1': true });
  expect(latest.messages.some((message) => message.role === 'activity' && message.status === 'running')).toBe(true);
});
