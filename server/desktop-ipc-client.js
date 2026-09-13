// Codex Desktop IPC client.
// Frame format: 4-byte little-endian length prefix + UTF-8 JSON payload.
// Protocol method names and version numbers track the Codex Desktop client
// (see flyyangX/CodexMobile@main/server/desktop-ipc-client.js for reference).

import crypto from 'node:crypto';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_DESKTOP_IPC_VERSIONS, createIpcVersionStore } from './desktop-ipc-versions.js';

const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_AUTO_BUMPS = 3;
const VERSION_ERROR_PATTERN = /version|unsupported method|unknown method/i;

export function desktopIpcMethodVersion(method) {
  return DEFAULT_DESKTOP_IPC_VERSIONS[method] || 0;
}

function isVersionError(errorString) {
  return typeof errorString === 'string' && VERSION_ERROR_PATTERN.test(errorString);
}

let defaultVersionStorePromise = null;
export function getDefaultIpcVersionStore({ stateDir } = {}) {
  if (!defaultVersionStorePromise) {
    const store = createIpcVersionStore({ stateDir });
    defaultVersionStorePromise = store.init().then(() => store);
  }
  return defaultVersionStorePromise;
}

export function desktopIpcSocketPath() {
  if (process.platform === 'win32') {
    return String.raw`\\.\pipe\codex-ipc`;
  }
  const uid = process.getuid?.();
  return path.join(os.tmpdir(), 'codex-ipc', uid != null ? `ipc-${uid}.sock` : 'ipc.sock');
}

export function encodeFrame(payload) {
  const json = JSON.stringify(payload);
  const size = Buffer.byteLength(json, 'utf8');
  const frame = Buffer.alloc(4 + size);
  frame.writeUInt32LE(size, 0);
  frame.write(json, 4, 'utf8');
  return frame;
}

export function decodeFrames(buffer) {
  const messages = [];
  let cursor = 0;
  while (cursor + 4 <= buffer.length) {
    const size = buffer.readUInt32LE(cursor);
    if (size > MAX_FRAME_BYTES) {
      throw new Error('Desktop IPC frame too large');
    }
    if (cursor + 4 + size > buffer.length) break;
    const raw = buffer.subarray(cursor + 4, cursor + 4 + size);
    cursor += 4 + size;
    try {
      messages.push(JSON.parse(raw.toString('utf8')));
    } catch {
      // Drop malformed frames, keep parsing the next one.
    }
  }
  return { messages, remainder: buffer.subarray(cursor) };
}

function ipcError(message, code = 'CODEXMOBILE_DESKTOP_IPC_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function getDesktopIpcSocketStatus(sockPath = desktopIpcSocketPath()) {
  if (process.platform === 'win32') {
    return { ok: true, socketPath: sockPath, reason: null };
  }
  try {
    const stat = fsSync.statSync(sockPath);
    if (!stat.isSocket()) {
      return { ok: false, socketPath: sockPath, reason: `桌面端 IPC 路径不是 socket: ${sockPath}` };
    }
    return { ok: true, socketPath: sockPath, reason: null };
  } catch (error) {
    return {
      ok: false,
      socketPath: sockPath,
      reason: error.code === 'ENOENT'
        ? `桌面端 IPC socket 不存在: ${sockPath}`
        : `无法访问桌面端 IPC socket: ${error.message}`
    };
  }
}

export class DesktopIpcClient {
  constructor({
    clientType = 'codexmobile',
    socketPath = desktopIpcSocketPath(),
    versionStore = null,
    maxAutoBumps = DEFAULT_MAX_AUTO_BUMPS,
    isVersionError: isVersionErrorFn = isVersionError,
    onBroadcast = null,
    onClose = null
  } = {}) {
    this.clientType = clientType;
    this.socketPath = socketPath;
    this.clientId = 'initializing-client';
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.versionStore = versionStore;
    this.maxAutoBumps = Math.max(0, Number(maxAutoBumps) || 0);
    this.isVersionError = isVersionErrorFn;
    this.onBroadcast = onBroadcast;
    this.onClose = onClose;
  }

  resolveVersion(method) {
    if (this.versionStore) {
      try {
        const value = this.versionStore.getVersion(method);
        if (value > 0) return value;
      } catch {
        // fall through
      }
    }
    return desktopIpcMethodVersion(method);
  }

  async connect({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.socket?.writable) return this;
    const status = getDesktopIpcSocketStatus(this.socketPath);
    if (!status.ok) {
      throw ipcError(status.reason || '桌面端 Codex IPC 未连接', 'CODEXMOBILE_DESKTOP_IPC_UNAVAILABLE');
    }
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(ipcError('连接桌面端 Codex IPC 超时', 'CODEXMOBILE_DESKTOP_IPC_TIMEOUT'));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timeout);
        this.socket = socket;
        socket.on('data', (chunk) => this.handleData(chunk));
        socket.on('close', () => {
          this.socket = null;
          this.rejectAll(ipcError('桌面端 Codex IPC 已断开', 'CODEXMOBILE_DESKTOP_IPC_CLOSED'));
          if (this.onClose) {
            try { this.onClose(); } catch (error) { console.warn('[ipc-client] onClose threw:', error.message); }
          }
        });
        socket.on('error', (error) => this.rejectAll(error));
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    const initialized = await this.request('initialize', { clientType: this.clientType }, { timeoutMs });
    if (initialized?.resultType !== 'success' || initialized?.method !== 'initialize') {
      throw ipcError(initialized?.error || '桌面端 Codex IPC 初始化失败');
    }
    this.clientId = initialized.result?.clientId || this.clientId;
    return this;
  }

  async _sendRequest(method, params, { timeoutMs, targetClientId, version }) {
    if (!this.socket?.writable) {
      throw ipcError('桌面端 Codex IPC 未连接', 'CODEXMOBILE_DESKTOP_IPC_UNAVAILABLE');
    }
    const requestId = crypto.randomUUID();
    const payload = { type: 'request', requestId, sourceClientId: this.clientId, version, method, params };
    if (targetClientId) payload.targetClientId = targetClientId;
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(ipcError(`桌面端 Codex IPC 请求超时: ${method}`, 'CODEXMOBILE_DESKTOP_IPC_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
    });
    this.socket.write(encodeFrame(payload));
    return promise;
  }

  async request(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, targetClientId = null, version } = {}) {
    const explicitVersion = version != null;
    let attemptVersion = explicitVersion ? version : this.resolveVersion(method);
    let lastResponse = null;
    const maxAttempts = explicitVersion ? 1 : this.maxAutoBumps + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await this._sendRequest(method, params, { timeoutMs, targetClientId, version: attemptVersion });
      lastResponse = response;
      if (response.resultType !== 'error' || !this.isVersionError(response.error)) {
        if (response.resultType !== 'error' && this.versionStore && !explicitVersion) {
          try {
            await this.versionStore.recordVersion(method, attemptVersion);
          } catch (err) {
            console.warn(`[ipc-client] failed to persist version for ${method}: ${err.message}`);
          }
        }
        return response;
      }
      if (attempt + 1 < maxAttempts) {
        const nextVersion = attemptVersion + 1;
        console.warn(`[ipc-client] auto-bumping ${method} v${attemptVersion} → v${nextVersion} (desktop: ${response.error})`);
        attemptVersion = nextVersion;
      }
    }
    if (lastResponse?.resultType === 'error') {
      console.warn(
        `[ipc-client] ${method} failed after ${maxAttempts} attempt(s): ${lastResponse.error}. ` +
        `If desktop was upgraded, run: npm run ipc:probe`
      );
    }
    return lastResponse;
  }

  sendBroadcast(method, params = {}, { version } = {}) {
    if (!this.socket?.writable) {
      throw ipcError('桌面端 Codex IPC 未连接', 'CODEXMOBILE_DESKTOP_IPC_UNAVAILABLE');
    }
    this.socket.write(encodeFrame({
      type: 'broadcast',
      method,
      sourceClientId: this.clientId,
      version: version ?? this.resolveVersion(method),
      params
    }));
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let parsed;
    try {
      parsed = decodeFrames(this.buffer);
    } catch (error) {
      this.close();
      this.rejectAll(error);
      return;
    }
    this.buffer = parsed.remainder;
    for (const message of parsed.messages) this.handleMessage(message);
  }

  handleMessage(message) {
    if (message.type === 'client-discovery-request') {
      this.socket?.write(encodeFrame({
        type: 'client-discovery-response',
        requestId: message.requestId,
        response: { canHandle: false }
      }));
      return;
    }
    if (message.type === 'broadcast') {
      if (this.onBroadcast) {
        try { this.onBroadcast(message); } catch (error) { console.warn('[ipc-client] onBroadcast threw:', error.message); }
      }
      return;
    }
    if (message.type !== 'response') return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timeout);
    pending.resolve(message);
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
  }
}

function describeIpcError(err, method) {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    return err.message || err.code || err.kind || JSON.stringify(err);
  }
  return `桌面端 Codex 拒绝请求: ${method}`;
}

function isNoClientFound(err) {
  if (!err) return false;
  if (typeof err === 'string') return err === 'no-client-found';
  if (typeof err === 'object') {
    return err.code === 'no-client-found'
      || err.kind === 'no-client-found'
      || err.message === 'no-client-found'
      || err.error === 'no-client-found';
  }
  return false;
}

async function requestDesktopFollower(method, params, { timeoutMs = DEFAULT_TIMEOUT_MS, socketPath = desktopIpcSocketPath(), versionStore } = {}) {
  const store = versionStore || (await getDefaultIpcVersionStore());
  const client = new DesktopIpcClient({ socketPath, versionStore: store });
  try {
    await client.connect({ timeoutMs });
    const response = await client.request(method, params, { timeoutMs });
    if (response.resultType === 'error') {
      const message = describeIpcError(response.error, method);
      const error = ipcError(message);
      error.statusCode = isNoClientFound(response.error) ? 409 : 502;
      error.raw = response.error;
      throw error;
    }
    return response.result;
  } finally {
    client.close();
  }
}

export async function startDesktopFollowerTurn(conversationId, turnStartParams = {}, options = {}) {
  return requestDesktopFollower('thread-follower-start-turn', {
    conversationId,
    turnStartParams
  }, options);
}

export async function interruptDesktopFollowerTurn(conversationId, options = {}) {
  return requestDesktopFollower('thread-follower-interrupt-turn', { conversationId }, options);
}

export async function steerDesktopFollowerTurn(conversationId, { input = '', attachments = [], restoreMessage = {} } = {}, options = {}) {
  return requestDesktopFollower('thread-follower-steer-turn', {
    conversationId,
    input,
    attachments,
    restoreMessage
  }, options);
}

export async function probeDesktopIpc({ timeoutMs = 3000, socketPath = desktopIpcSocketPath() } = {}) {
  const status = getDesktopIpcSocketStatus(socketPath);
  if (!status.ok) {
    return { connected: false, mode: 'desktop-ipc', socketPath: status.socketPath, reason: status.reason };
  }
  const client = new DesktopIpcClient({ socketPath });
  try {
    await client.connect({ timeoutMs });
    return { connected: true, mode: 'desktop-ipc', socketPath: status.socketPath, reason: null };
  } catch (error) {
    return {
      connected: false,
      mode: 'desktop-ipc',
      socketPath: status.socketPath,
      reason: error.message || '桌面端 Codex IPC 连接失败'
    };
  } finally {
    client.close();
  }
}
