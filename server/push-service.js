import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_SUBJECT = 'mailto:codexmobile@localhost';
const GONE_STATUS_CODES = new Set([404, 410]);
const VAPID_FILE = 'vapid.json';
const SUBS_FILE = 'push-subscriptions.json';

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date().toISOString();
}

function normalizeSubscription(subscription = {}) {
  const endpoint = String(subscription?.endpoint || '').trim();
  const keys = subscription?.keys && typeof subscription.keys === 'object' ? subscription.keys : {};
  const p256dh = String(keys.p256dh || '').trim();
  const auth = String(keys.auth || '').trim();
  if (!endpoint || !p256dh || !auth) {
    const error = new Error('Invalid push subscription: endpoint and keys.p256dh/keys.auth are required');
    error.statusCode = 400;
    throw error;
  }
  return {
    endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: { p256dh, auth }
  };
}

export function notificationFromServerPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const type = payload.type;
  if (type === 'chat-completed') {
    return {
      level: 'success',
      title: '任务已完成',
      body: payload.detail || payload.summary || 'Codex 已处理完当前任务。'
    };
  }
  if (type === 'approval-needed') {
    return {
      level: 'warning',
      title: '需要处理',
      body: payload.label || payload.detail || 'Codex 正在等待你的确认或输入。'
    };
  }
  if (type === 'error') {
    return {
      level: 'error',
      title: '任务失败',
      body: payload.error || payload.detail || 'Codex 执行时遇到错误。'
    };
  }
  return null;
}

export function createPushService({
  stateDir,
  subject = DEFAULT_SUBJECT,
  webPush = null,
  now = () => new Date()
} = {}) {
  if (!stateDir) {
    throw new Error('createPushService: stateDir is required');
  }

  const vapidPath = path.join(stateDir, VAPID_FILE);
  const subsPath = path.join(stateDir, SUBS_FILE);

  let webPushPromise = null;
  let initPromise = null;
  let vapid = null; // { publicKey, privateKey, subject }
  let subscriptions = []; // array of saved subscription records

  async function getWebPush() {
    if (webPush) return webPush;
    if (!webPushPromise) {
      webPushPromise = import('web-push').then((mod) => mod.default || mod);
    }
    return webPushPromise;
  }

  async function readJson(filePath) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) {
        console.warn(`[push-service] Corrupt state file ${filePath}, ignoring:`, error.message);
        return null;
      }
      console.warn(`[push-service] Failed to read ${filePath}:`, error.message);
      return null;
    }
  }

  async function writeJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
  }

  async function loadVapid(lib) {
    const parsed = await readJson(vapidPath);
    if (parsed && parsed.publicKey && parsed.privateKey) {
      // Caller-provided subject (via env) takes precedence over persisted value.
      const effectiveSubject = subject !== DEFAULT_SUBJECT ? subject : String(parsed.subject || subject);
      vapid = {
        publicKey: String(parsed.publicKey),
        privateKey: String(parsed.privateKey),
        subject: effectiveSubject
      };
      if (parsed.subject !== effectiveSubject) {
        await writeJson(vapidPath, vapid);
      }
    } else {
      const keys = lib.generateVAPIDKeys();
      vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject };
      await writeJson(vapidPath, vapid);
    }
    if (typeof lib.setVapidDetails === 'function') {
      lib.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    }
  }

  async function loadSubscriptions() {
    const parsed = await readJson(subsPath);
    if (parsed && Array.isArray(parsed.subscriptions)) {
      subscriptions = parsed.subscriptions
        .filter((item) => item && item.endpoint && item.keys && item.keys.p256dh && item.keys.auth)
        .map((item) => ({
          endpoint: String(item.endpoint),
          expirationTime: item.expirationTime ?? null,
          keys: { p256dh: String(item.keys.p256dh), auth: String(item.keys.auth) },
          userAgent: item.userAgent ? String(item.userAgent) : null,
          createdAt: item.createdAt || null,
          updatedAt: item.updatedAt || null
        }));
    } else {
      subscriptions = [];
    }
  }

  async function persistSubscriptions() {
    await writeJson(subsPath, { version: 1, subscriptions });
  }

  async function ensureInit() {
    if (!initPromise) {
      initPromise = (async () => {
        const lib = await getWebPush();
        await loadVapid(lib);
        await loadSubscriptions();
      })();
    }
    return initPromise;
  }

  async function publicStatus() {
    await ensureInit();
    return {
      supported: true,
      subject: vapid.subject,
      publicKey: vapid.publicKey,
      subscriberCount: subscriptions.length
    };
  }

  async function subscribe(subscription, { userAgent } = {}) {
    const normalized = normalizeSubscription(subscription);
    await ensureInit();
    const nowIso = toIso(now());
    const index = subscriptions.findIndex((item) => item.endpoint === normalized.endpoint);
    const record = {
      endpoint: normalized.endpoint,
      expirationTime: normalized.expirationTime,
      keys: normalized.keys,
      userAgent: userAgent ? String(userAgent) : (index >= 0 ? subscriptions[index].userAgent : null),
      createdAt: index >= 0 ? subscriptions[index].createdAt : nowIso,
      updatedAt: nowIso
    };
    if (index >= 0) {
      subscriptions[index] = record;
    } else {
      subscriptions.push(record);
    }
    await persistSubscriptions();
    return record;
  }

  async function unsubscribe(endpoint) {
    const value = String(endpoint || '').trim();
    if (!value) return { removed: false };
    await ensureInit();
    const before = subscriptions.length;
    subscriptions = subscriptions.filter((item) => item.endpoint !== value);
    const removed = subscriptions.length !== before;
    if (removed) await persistSubscriptions();
    return { removed };
  }

  async function sendNotification(payload = {}) {
    await ensureInit();
    if (!subscriptions.length) {
      return { sent: 0, removed: 0 };
    }
    const lib = await getWebPush();
    const targets = [...subscriptions];
    const body = JSON.stringify({
      title: payload.title || 'CodexMobile',
      body: payload.body || '',
      level: payload.level || 'info',
      tag: payload.tag || `codexmobile-${payload.title || 'notification'}`,
      url: payload.url || '/',
      data: payload.data || null
    });
    let sent = 0;
    const gone = new Set();
    await Promise.all(targets.map(async (sub) => {
      try {
        await lib.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys, expirationTime: sub.expirationTime ?? null },
          body
        );
        sent += 1;
      } catch (error) {
        const status = Number(error?.statusCode);
        if (GONE_STATUS_CODES.has(status)) {
          gone.add(sub.endpoint);
        } else {
          console.warn('[push-service] sendNotification failed:', error?.message || error);
        }
      }
    }));
    if (gone.size) {
      subscriptions = subscriptions.filter((item) => !gone.has(item.endpoint));
      await persistSubscriptions();
    }
    return { sent, removed: gone.size };
  }

  async function notifyForPayload(serverPayload) {
    const notification = notificationFromServerPayload(serverPayload);
    if (!notification) return { sent: 0, removed: 0 };
    return sendNotification({
      ...notification,
      tag: `codexmobile-${serverPayload?.type || notification.title}`,
      url: '/',
      data: serverPayload || null
    });
  }

  return {
    publicStatus,
    subscribe,
    unsubscribe,
    sendNotification,
    notifyForPayload
  };
}

const DEFAULT_STATE_DIR = path.join(process.cwd(), '.codexmobile', 'state');
const defaultService = createPushService({ stateDir: DEFAULT_STATE_DIR });

export const publicStatus = (...args) => defaultService.publicStatus(...args);
export const subscribe = (...args) => defaultService.subscribe(...args);
export const unsubscribe = (...args) => defaultService.unsubscribe(...args);
export const sendNotification = (...args) => defaultService.sendNotification(...args);
export const notifyForPayload = (...args) => defaultService.notifyForPayload(...args);
