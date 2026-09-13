// Chat queue + send + abort + steer + compact routes. Most handlers
// delegate to chatService (Batch D); /api/chat/steer talks to the desktop
// IPC follower directly; /api/chat/compact runs the Claude CLI to
// summarize a session and appends a compact_boundary marker to the
// session's JSONL on disk.
//
// Extracted from server/index.js (Batch G R30 — final route extraction).
//
// Inputs:
//   chatService                  — Batch D service (queue + send + abort + turn lookup)
//   steerDesktopFollowerTurn     — from ./desktop-ipc-client.js
//   findClaudeSessionJsonlPath   — from ./codex-data.js
//   getAllActiveRuns             — () => Array<run> — caller-built union
//                                  of codex + desktop-turn-monitor +
//                                  chatService desktop-IPC + image runs
//   broadcast                    — WebSocket broadcast fn
//   remoteAddress                — req → ip (for log lines)
//
// Returns: async handle(req, res, ctx) → boolean. ctx = { method,
// pathname, parts, url }.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import { readBody, sendJson } from './http-utils.js';

const COMPACT_TIMEOUT_MS = 90_000;
const COMPACT_PROMPT_LIMIT = 40_000;
const COMPACT_SUMMARY_MIN_TURNS = 2;

function buildCompactPrompt(conversationText) {
  return `You are compacting a Claude Code conversation. Create a concise summary (300-600 words) of the key decisions, files modified, bugs fixed, and what needs to be done next. Start with: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion:\n\n"\n\nConversation:\n\n${conversationText.slice(0, COMPACT_PROMPT_LIMIT)}`;
}

function extractClaudeTurns(jsonl) {
  const lines = jsonl.split(/\r?\n/).filter(Boolean);
  const turns = [];
  let lastUuid = null;
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record.uuid) lastUuid = record.uuid;
      if (record.type === 'user' && !record.isMeta && record.message?.role === 'user') {
        const text = typeof record.message.content === 'string'
          ? record.message.content
          : (record.message.content || []).filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
        if (text.trim()) turns.push(`Human: ${text.trim()}`);
      } else if (record.type === 'assistant' && record.message?.role === 'assistant') {
        const parts = Array.isArray(record.message.content) ? record.message.content : [];
        const text = parts.filter((p) => p?.type === 'text').map((p) => p.text || '').join('\n').trim();
        if (text) turns.push(`Assistant: ${text}`);
      }
    } catch { /* skip malformed lines */ }
  }
  return { turns, lastUuid };
}

function runClaudeSummarize(prompt) {
  return new Promise((resolve, reject) => {
    const claudeExe = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    const child = spawn(claudeExe, ['-p', '--no-session-persistence', '--model', 'haiku'], {
      cwd: os.tmpdir(),
      env: { ...process.env },
      windowsHide: true,
      shell: process.platform === 'win32'
    });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      reject(new Error(`compact summarization timed out after ${Math.round(COMPACT_TIMEOUT_MS / 1000)}s`));
    }, COMPACT_TIMEOUT_MS);
    child.on('error', (spawnError) => {
      clearTimeout(timer);
      reject(spawnError);
    });
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code === 0 && out.trim()) {
        resolve(out.trim());
      } else {
        reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
      }
    });
    child.stdin.end(prompt, 'utf8');
  });
}

export function createChatRoutes({
  chatService,
  steerDesktopFollowerTurn,
  findClaudeSessionJsonlPath,
  getAllActiveRuns,
  broadcast,
  remoteAddress
}) {
  if (!chatService) throw new Error('createChatRoutes: chatService is required');
  if (typeof steerDesktopFollowerTurn !== 'function') throw new Error('createChatRoutes: steerDesktopFollowerTurn is required');
  if (typeof findClaudeSessionJsonlPath !== 'function') throw new Error('createChatRoutes: findClaudeSessionJsonlPath is required');
  if (typeof getAllActiveRuns !== 'function') throw new Error('createChatRoutes: getAllActiveRuns is required');
  if (typeof broadcast !== 'function') throw new Error('createChatRoutes: broadcast is required');
  if (typeof remoteAddress !== 'function') throw new Error('createChatRoutes: remoteAddress is required');

  return async function handle(req, res, ctx) {
    const { method, pathname, parts, url } = ctx;

    if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'chat' && parts[2] === 'turns') {
      const turnId = decodeURIComponent(parts[3]);
      sendJson(res, 200, { turn: chatService.getTurn(turnId) || null });
      return true;
    }

    if (method === 'GET' && pathname === '/api/chat/queue') {
      sendJson(res, 200, chatService.listQueue({
        sessionId: url.searchParams.get('sessionId') || '',
        draftSessionId: url.searchParams.get('draftSessionId') || ''
      }));
      return true;
    }

    if (method === 'DELETE' && pathname === '/api/chat/queue') {
      const body = await readBody(req);
      const removed = chatService.removeQueuedDraft(body);
      sendJson(res, removed ? 200 : 404, { success: Boolean(removed), draft: removed });
      return true;
    }

    if (method === 'POST' && pathname === '/api/chat/queue/restore') {
      const body = await readBody(req);
      const draft = chatService.restoreQueuedDraft(body);
      sendJson(res, draft ? 200 : 404, { success: Boolean(draft), draft });
      return true;
    }

    if (method === 'POST' && pathname === '/api/chat/queue/steer') {
      try {
        const body = await readBody(req);
        const result = await chatService.steerQueuedDraft(body);
        sendJson(res, result ? 200 : 404, { success: Boolean(result), result });
      } catch (error) {
        sendJson(res, error.statusCode || 500, { error: error.message || 'Failed to steer queued draft' });
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/chat/send') {
      try {
        const body = await readBody(req);
        const result = await chatService.sendChat(body, { remoteAddress: remoteAddress(req) });
        sendJson(res, 202, result);
      } catch (error) {
        const statusCode = error.statusCode || 500;
        console.warn(`[chat] send failed status=${statusCode}: ${error.message}`);
        sendJson(res, statusCode, { error: error.message || 'Failed to send chat' });
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/chat/abort') {
      try {
        const body = await readBody(req);
        const aborted = await chatService.abortChat(body, { remoteAddress: remoteAddress(req) });
        sendJson(res, aborted ? 200 : 404, { aborted });
      } catch (error) {
        sendJson(res, error.statusCode || 500, { error: error.message || 'abort failed' });
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/chat/steer') {
      const body = await readBody(req);
      const sessionId = String(body.sessionId || '').trim();
      const input = String(body.input || '').trim();
      if (!sessionId || sessionId.startsWith('draft-')) {
        sendJson(res, 400, { error: 'sessionId is required and must not be a draft' });
        return true;
      }
      if (!input) {
        sendJson(res, 400, { error: 'input is required' });
        return true;
      }
      try {
        const result = await steerDesktopFollowerTurn(sessionId, {
          input,
          attachments: Array.isArray(body.attachments) ? body.attachments : [],
          restoreMessage: body.restoreMessage || {}
        }, { timeoutMs: 4000 });
        console.log(`[chat] steer via IPC session=${sessionId}`);
        sendJson(res, 200, { success: true, result });
      } catch (error) {
        const status = error.statusCode || 502;
        console.warn(`[chat] steer failed session=${sessionId}: ${error.message}`);
        sendJson(res, status, { error: error.message || 'steer failed' });
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/chat/compact') {
      const body = await readBody(req);
      const sessionId = String(body.sessionId || '').trim();
      const projectId = String(body.projectId || '').trim();

      if (!sessionId || sessionId.startsWith('draft-') || sessionId.startsWith('codex-')) {
        sendJson(res, 400, { error: 'A real Claude session ID is required' });
        return true;
      }

      const sessionPath = await findClaudeSessionJsonlPath(sessionId);
      if (!sessionPath) {
        sendJson(res, 404, { error: 'Session file not found on disk' });
        return true;
      }

      const content = await fs.readFile(sessionPath, 'utf8');
      const { turns, lastUuid } = extractClaudeTurns(content);

      if (turns.length < COMPACT_SUMMARY_MIN_TURNS) {
        sendJson(res, 200, { compacted: false, reason: 'conversation too short to compact' });
        return true;
      }

      // Reject if a turn for this session is already running (would corrupt the tree)
      const allActive = getAllActiveRuns();
      const sessionBusy = allActive.some(
        (r) => r.sessionId === sessionId || r.previousSessionId === sessionId
      );
      if (sessionBusy) {
        sendJson(res, 409, { error: 'A turn is currently running for this session. Wait for it to finish before compacting.' });
        return true;
      }

      const conversationText = turns.join('\n\n');
      const compactPrompt = buildCompactPrompt(conversationText);

      let summary = '';
      try {
        summary = await runClaudeSummarize(compactPrompt);
      } catch (error) {
        console.warn(`[compact] summarization failed: ${error.message}`);
        sendJson(res, 500, { error: `Failed to generate summary: ${error.message}` });
        return true;
      }

      const now = new Date().toISOString();
      const compactUuid = crypto.randomUUID();
      const summaryUuid = crypto.randomUUID();
      const compactBoundary = {
        parentUuid: null,
        logicalParentUuid: lastUuid,
        isSidechain: false,
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        isMeta: false,
        timestamp: now,
        uuid: compactUuid,
        level: 'info',
        compactMetadata: {
          trigger: 'manual',
          preTokens: Math.round(conversationText.length / 4),
          postTokens: Math.round(summary.length / 4),
          durationMs: 0
        },
        sessionId
      };
      const summaryEntry = {
        parentUuid: compactUuid,
        isSidechain: false,
        type: 'user',
        message: { role: 'user', content: summary },
        uuid: summaryUuid,
        timestamp: now,
        sessionId
      };
      await fs.appendFile(sessionPath,
        '\n' + JSON.stringify(compactBoundary) + '\n' + JSON.stringify(summaryEntry),
        'utf8'
      );

      console.log(`[compact] session=${sessionId} preTokens=${compactBoundary.compactMetadata.preTokens} postTokens=${compactBoundary.compactMetadata.postTokens}`);
      broadcast({ type: 'compact-complete', sessionId, projectId, summaryUuid });
      sendJson(res, 200, { compacted: true, sessionId, summaryUuid });
      return true;
    }

    return false;
  };
}

// Exported helpers for unit testing the pure parts of the compact path
// without spawning the Claude CLI.
export { buildCompactPrompt, extractClaudeTurns };
