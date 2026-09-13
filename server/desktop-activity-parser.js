import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import readline from 'node:readline';
import { statusLabel } from './codex-runner.js';

const RAW_SESSION_ACTIVITY_OUTPUT_LIMIT = 6000;
const ROLLOUT_HISTORY_OUTPUT_LIMIT = Math.max(
  200,
  Number(process.env.CODEXMOBILE_HISTORY_OUTPUT_LIMIT) || 1000
);
const RAW_SESSION_COMMAND_TOOLS = new Set(['exec_command', 'write_stdin', 'read_thread_terminal', 'shell']);

function truncateActivityText(value, limit = RAW_SESSION_ACTIVITY_OUTPUT_LIMIT) {
  const text = String(value || '');
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n... truncated ${text.length - limit} chars`;
}

function parseJsonObject(value) {
  if (!value) {
    return {};
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function responseMessageText(message) {
  const content = message?.payload?.content ?? message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.map((part) => part?.text || part?.content || '').filter(Boolean).join('');
}

function rawFunctionExitCode(value) {
  const text = String(value || '');
  const match = text.match(/\bProcess exited with code (-?\d+)\b/i) || text.match(/\bExit code: (-?\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function cleanRawFunctionOutput(value, limit = RAW_SESSION_ACTIVITY_OUTPUT_LIMIT) {
  if (value === null || value === undefined) {
    return '';
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const marker = '\nOutput:\n';
  const markerIndex = text.indexOf(marker);
  const visible = markerIndex >= 0 ? text.slice(markerIndex + marker.length) : text;
  return truncateActivityText(visible.trimEnd(), limit);
}

function rawFunctionStatus(outputRecord, missingOutputStatus = 'running') {
  if (!outputRecord) {
    return missingOutputStatus;
  }
  const exitCode = rawFunctionExitCode(outputRecord.output);
  if (exitCode === null) {
    return 'completed';
  }
  return exitCode === 0 ? 'completed' : 'failed';
}

// Codex 0.149 stopped emitting `function_call`/`exec_command` for shell work.
// A command now arrives as `custom_tool_call` whose `input` is a JS snippet
// calling `tools.exec_command({...})`, so the command text sits inside a JSON
// object embedded in a string. Pull it back out; anything we can't read (or a
// non-command tool such as `wait`) yields null and is skipped.
function jsonObjectAfter(text, startIndex) {
  const open = text.indexOf('{', startIndex);
  if (open < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return parseJsonObject(text.slice(open, index + 1));
      }
    }
  }
  return null;
}

// The embedded argument object is a JS literal, not JSON — Codex emits both
// `{"cmd":"…"}` and `{cmd: "…"}` — so fall back to reading the string literal
// for the field directly when JSON.parse rejects it.
function stringFieldFromJsLiteral(text, field) {
  const match = new RegExp(`["']?${field}["']?\\s*:\\s*`).exec(text);
  if (!match) {
    return '';
  }
  let index = match.index + match[0].length;
  const quote = text[index];
  if (quote !== '"' && quote !== "'" && quote !== '`') {
    return '';
  }
  index += 1;
  let raw = '';
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      raw += char + (text[index + 1] ?? '');
      index += 2;
      continue;
    }
    if (char === quote) {
      break;
    }
    raw += char;
    index += 1;
  }
  try {
    return JSON.parse(`"${raw.replace(/(?<!\\)"/g, '\\"')}"`);
  } catch {
    return raw;
  }
}

function commandFieldFrom(args, text) {
  for (const field of ['cmd', 'command', 'input', 'text']) {
    const fromJson = args?.[field];
    if (fromJson) {
      return String(fromJson);
    }
    const fromLiteral = stringFieldFromJsLiteral(text, field);
    if (fromLiteral) {
      return fromLiteral;
    }
  }
  return '';
}

export function commandFromToolCallPayload(payload) {
  const type = payload?.type || '';
  if (type === 'custom_tool_call') {
    const input = String(payload.input || '');
    const call = input.match(/tools\.(\w+)\s*\(/);
    if (!call) {
      return null;
    }
    const toolName = call[1];
    if (!RAW_SESSION_COMMAND_TOOLS.has(toolName)) {
      return null;
    }
    const args = jsonObjectAfter(input, call.index + call[0].length - 1) || {};
    const command = commandFieldFrom(args, input.slice(call.index));
    return command ? { command, toolName } : null;
  }
  if (type === 'function_call') {
    const toolName = payload.name || payload.tool_name || '';
    if (!RAW_SESSION_COMMAND_TOOLS.has(toolName)) {
      return null;
    }
    const args = parseJsonObject(payload.arguments);
    const command = args.command || args.input || args.text || '';
    return command ? { command: String(command), toolName } : null;
  }
  return null;
}

// Build the collapsed "ran a command" step for a rollout tool call. The reader
// fills in the output later, once the matching *_output row shows up.
export function rolloutCommandActivity(payload, { timestamp, turnId, idSuffix }) {
  const parsed = commandFromToolCallPayload(payload);
  if (!parsed || !turnId) {
    return null;
  }
  const status = String(payload.status || '') === 'completed' ? 'completed' : 'running';
  return {
    id: `${turnId}-raw-command-${idSuffix}`,
    kind: 'command_execution',
    label: statusLabel('command_execution', status),
    status,
    detail: parsed.command,
    command: parsed.command,
    output: '',
    exitCode: null,
    toolName: parsed.toolName,
    timestamp
  };
}

export function applyRolloutCommandOutput(activity, payload) {
  if (!activity) {
    return;
  }
  const raw = Array.isArray(payload?.output)
    ? payload.output.map((part) => part?.text || part?.content || '').filter(Boolean).join('\n')
    : payload?.output;
  const status = rawFunctionStatus({ output: raw });
  // A finished session can hold hundreds of command steps; at the live path's
  // 6000-char budget one history load ran 681 KB over the wire. Keep enough to
  // see what a step did (the marker says how much was cut).
  activity.output = cleanRawFunctionOutput(raw, ROLLOUT_HISTORY_OUTPUT_LIMIT);
  activity.exitCode = rawFunctionExitCode(raw);
  activity.status = status;
  activity.label = statusLabel('command_execution', status);
}

function epochMillisFromTurnValue(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function turnIdForTimestamp(turns, timestamp) {
  const time = Date.parse(timestamp || '');
  if (!Number.isFinite(time) || !Array.isArray(turns) || turns.length === 0) {
    return null;
  }
  let latestStartedTurnId = null;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index] || {};
    const turnId = turn.id;
    if (!turnId) continue;
    const start = epochMillisFromTurnValue(turn.startedAt);
    if (start === null) continue;
    const completed = epochMillisFromTurnValue(turn.completedAt);
    const nextStart = epochMillisFromTurnValue(turns[index + 1]?.startedAt);
    const end = completed ?? nextStart ?? Number.POSITIVE_INFINITY;
    if (time >= start - 5000 && time <= end + 5000) {
      return turnId;
    }
    if (time >= start) {
      latestStartedTurnId = turnId;
    }
  }
  return latestStartedTurnId;
}

function missingOutputStatusForTurn(turns, turnId) {
  const turn = (Array.isArray(turns) ? turns : []).find((item) => item?.id === turnId);
  const status = String(turn?.status || '').toLowerCase();
  if (['completed', 'success', 'succeeded'].includes(status) || turn?.completedAt) {
    return 'completed';
  }
  if (['failed', 'error', 'cancelled', 'canceled', 'interrupted', 'aborted'].includes(status)) {
    return 'failed';
  }
  return 'running';
}

function comparableSequence(value) {
  const number = Number(value);
  if (Number.isFinite(number)) {
    return number;
  }
  const match = String(value || '').match(/^\d+/);
  return match ? Number(match[0]) : null;
}

function isVisibleUserMessage(message) {
  if (message?.payload?.role !== 'user' && message?.role !== 'user') {
    return false;
  }
  const text = responseMessageText(message);
  return Boolean(text && !/^<environment_context\b/i.test(text.trim()));
}

function segmentMarkersFromMessages(messages, turns) {
  const countsByTurn = new Map();
  const markers = [];
  const userMessages = (Array.isArray(messages) ? messages : [])
    .filter(isVisibleUserMessage)
    .sort((a, b) => (comparableSequence(a.sequence) ?? 0) - (comparableSequence(b.sequence) ?? 0));

  for (const message of userMessages) {
    const turnId = turnIdForTimestamp(turns, message.timestamp);
    if (!turnId) continue;
    const segmentIndex = countsByTurn.get(turnId) || 0;
    countsByTurn.set(turnId, segmentIndex + 1);
    markers.push({
      turnId,
      segmentIndex,
      sequence: comparableSequence(message.sequence),
      timestampMs: Date.parse(message.timestamp || '')
    });
  }
  return markers;
}

function segmentIndexForActivity(markers, item) {
  const activity = item?.activity || {};
  const sequence = comparableSequence(activity.sequence);
  const timestampMs = Date.parse(activity.timestamp || '');
  let match = null;
  for (const marker of markers || []) {
    if (marker.turnId !== item?.turnId) continue;
    const sequenceApplies = Number.isFinite(sequence) && Number.isFinite(marker.sequence)
      ? marker.sequence <= sequence
      : false;
    const timestampApplies = Number.isFinite(timestampMs) && Number.isFinite(marker.timestampMs)
      ? marker.timestampMs <= timestampMs
      : false;
    if (sequenceApplies || (!Number.isFinite(sequence) && timestampApplies)) {
      match = marker;
    }
  }
  return match?.segmentIndex || 0;
}

function applyActivitySegments(items, messages, turns) {
  const markers = segmentMarkersFromMessages(messages, turns);
  if (!markers.length) {
    return items;
  }
  return items.map((item) => ({
    ...item,
    segmentIndex: segmentIndexForActivity(markers, item)
  }));
}

function commandActivityFromCall({ payload, outputRecord, turns, sequence, command, toolName }) {
  const timestamp = payload.timestamp || outputRecord?.timestamp || new Date().toISOString();
  const turnId = turnIdForTimestamp(turns, timestamp);
  if (!turnId || !command) {
    return null;
  }
  const status = rawFunctionStatus(outputRecord, missingOutputStatusForTurn(turns, turnId));
  const exitCode = rawFunctionExitCode(outputRecord?.output);
  const idSuffix = payload.call_id || `${sequence}`;
  return {
    turnId,
    activity: {
      id: `${turnId}-raw-command-${idSuffix}`,
      kind: 'command_execution',
      label: statusLabel('command_execution', status),
      status,
      detail: command,
      command,
      output: cleanRawFunctionOutput(outputRecord?.output),
      exitCode,
      toolName,
      timestamp,
      sequence
    }
  };
}

function parseRawActivityRows(rows, turns) {
  const outputByCallId = new Map();
  const messages = [];
  const activities = [];

  for (const row of rows) {
    const payload = row.payload || {};
    if (payload.type === 'function_call_output' && payload.call_id) {
      outputByCallId.set(payload.call_id, {
        output: payload.output,
        timestamp: row.timestamp,
        sequence: row.sequence
      });
    }
    if (payload.type === 'message') {
      messages.push({ ...row, role: payload.role, content: payload.content });
    }
  }

  for (const row of rows) {
    const payload = row.payload || {};
    if (payload.type !== 'function_call') {
      continue;
    }
    const toolName = payload.name || payload.tool_name || '';
    if (!RAW_SESSION_COMMAND_TOOLS.has(toolName)) {
      continue;
    }
    const args = parseJsonObject(payload.arguments);
    const command = args.command || args.input || args.text || '';
    const activity = commandActivityFromCall({
      payload: { ...payload, timestamp: row.timestamp },
      outputRecord: outputByCallId.get(payload.call_id),
      turns,
      sequence: row.sequence,
      command,
      toolName
    });
    if (activity) {
      activities.push(activity);
    }
  }
  return applyActivitySegments(activities, messages, turns);
}

export async function readRawSessionActivities(filePath, turns = []) {
  if (!filePath) {
    return [];
  }
  const rows = [];
  let sequence = 0;
  try {
    const stream = fsSync.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        rows.push({ ...row, sequence: sequence += 1 });
      } catch {
        // Skip malformed JSONL rows.
      }
    }
  } catch {
    return [];
  }
  return parseRawActivityRows(rows, turns);
}

export async function readDesktopCollabActivities(filePath) {
  if (!filePath) {
    return [];
  }
  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const activities = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = row.payload || {};
    if (row.type !== 'event_msg' || payload.type !== 'agent_message') {
      continue;
    }
    const turnId = payload.turn_id || payload.turnId;
    if (!turnId) continue;
    activities.push({
      turnId,
      activity: {
        id: payload.id || `${turnId}-collab-${activities.length + 1}`,
        kind: 'agent_message',
        label: payload.label || '协作消息',
        status: payload.status || 'completed',
        detail: payload.message || payload.text || '',
        timestamp: row.timestamp || new Date().toISOString()
      }
    });
  }
  return activities;
}
