import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createPushService, notificationFromServerPayload } from './push-service.js';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-service-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function fakeWebPush(overrides = {}) {
  let counter = 0;
  const sent = [];
  return {
    sent,
    vapid: null,
    generateVAPIDKeys() {
      counter += 1;
      return { publicKey: `pub-${counter}`, privateKey: `priv-${counter}` };
    },
    setVapidDetails(subject, publicKey, privateKey) {
      this.vapid = { subject, publicKey, privateKey };
    },
    async sendNotification(subscription, payload) {
      sent.push({ subscription, payload: typeof payload === 'string' ? JSON.parse(payload) : payload });
      const status = overrides.statusFor ? overrides.statusFor(subscription) : 201;
      if (status >= 400) {
        const error = new Error(`status ${status}`);
        error.statusCode = status;
        throw error;
      }
      return { statusCode: status };
    }
  };
}

function makeFixedNow() {
  let counter = 0;
  return () => {
    counter += 1;
    return new Date(Date.UTC(2025, 0, 1, 0, 0, counter));
  };
}

test('publicStatus auto-generates VAPID keys on first call and persists vapid.json', async () => {
  const webPush = fakeWebPush();
  const service = createPushService({ stateDir: tmpDir, webPush, now: makeFixedNow() });
  const status = await service.publicStatus();
  assert.equal(status.supported, true);
  assert.equal(status.publicKey, 'pub-1');
  assert.equal(status.subscriberCount, 0);
  assert.match(status.subject, /^mailto:/);
  assert.deepEqual(webPush.vapid, { subject: status.subject, publicKey: 'pub-1', privateKey: 'priv-1' });
  const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'vapid.json'), 'utf8'));
  assert.equal(saved.publicKey, 'pub-1');
  assert.equal(saved.privateKey, 'priv-1');
});

test('VAPID keys persist across instances (no regeneration)', async () => {
  const a = createPushService({ stateDir: tmpDir, webPush: fakeWebPush(), now: makeFixedNow() });
  const first = await a.publicStatus();
  const webPushB = fakeWebPush();
  const b = createPushService({ stateDir: tmpDir, webPush: webPushB, now: makeFixedNow() });
  const second = await b.publicStatus();
  assert.equal(second.publicKey, first.publicKey);
  // setVapidDetails must still be called with the loaded keys
  assert.equal(webPushB.vapid.publicKey, first.publicKey);
});

test('subscribe rejects missing endpoint with 400', async () => {
  const service = createPushService({ stateDir: tmpDir, webPush: fakeWebPush(), now: makeFixedNow() });
  await assert.rejects(
    () => service.subscribe({ keys: { p256dh: 'p', auth: 'a' } }),
    (err) => err.statusCode === 400
  );
});

test('subscribe rejects missing keys with 400', async () => {
  const service = createPushService({ stateDir: tmpDir, webPush: fakeWebPush(), now: makeFixedNow() });
  await assert.rejects(
    () => service.subscribe({ endpoint: 'https://x/y' }),
    (err) => err.statusCode === 400
  );
  await assert.rejects(
    () => service.subscribe({ endpoint: 'https://x/y', keys: { p256dh: 'p' } }),
    (err) => err.statusCode === 400
  );
});

test('subscribe persists subscription and updates subscriber count', async () => {
  const service = createPushService({ stateDir: tmpDir, webPush: fakeWebPush(), now: makeFixedNow() });
  const record = await service.subscribe(
    { endpoint: 'https://push/one', keys: { p256dh: 'p1', auth: 'a1' } },
    { userAgent: 'Mozilla/Test' }
  );
  assert.equal(record.endpoint, 'https://push/one');
  assert.equal(record.keys.p256dh, 'p1');
  assert.equal(record.userAgent, 'Mozilla/Test');
  assert.match(record.createdAt, /^2025-01-01T/);
  const status = await service.publicStatus();
  assert.equal(status.subscriberCount, 1);
  const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'push-subscriptions.json'), 'utf8'));
  assert.equal(saved.subscriptions.length, 1);
  assert.equal(saved.subscriptions[0].endpoint, 'https://push/one');
});

test('subscribe is idempotent for the same endpoint (updates keys, no duplicate)', async () => {
  const service = createPushService({ stateDir: tmpDir, webPush: fakeWebPush(), now: makeFixedNow() });
  await service.subscribe({ endpoint: 'https://push/x', keys: { p256dh: 'p1', auth: 'a1' } });
  await service.subscribe({ endpoint: 'https://push/x', keys: { p256dh: 'p2', auth: 'a2' } });
  const status = await service.publicStatus();
  assert.equal(status.subscriberCount, 1);
  const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'push-subscriptions.json'), 'utf8'));
  assert.equal(saved.subscriptions[0].keys.p256dh, 'p2');
});

test('unsubscribe removes a known endpoint and returns removed:true', async () => {
  const service = createPushService({ stateDir: tmpDir, webPush: fakeWebPush(), now: makeFixedNow() });
  await service.subscribe({ endpoint: 'https://push/a', keys: { p256dh: 'p', auth: 'a' } });
  const result = await service.unsubscribe('https://push/a');
  assert.deepEqual(result, { removed: true });
  const status = await service.publicStatus();
  assert.equal(status.subscriberCount, 0);
});

test('unsubscribe returns removed:false for unknown endpoint', async () => {
  const service = createPushService({ stateDir: tmpDir, webPush: fakeWebPush(), now: makeFixedNow() });
  const result = await service.unsubscribe('https://push/missing');
  assert.deepEqual(result, { removed: false });
});

test('sendNotification fans out to every subscription', async () => {
  const webPush = fakeWebPush();
  const service = createPushService({ stateDir: tmpDir, webPush, now: makeFixedNow() });
  await service.subscribe({ endpoint: 'https://push/1', keys: { p256dh: 'p', auth: 'a' } });
  await service.subscribe({ endpoint: 'https://push/2', keys: { p256dh: 'p', auth: 'a' } });
  const result = await service.sendNotification({ title: 'Hi', body: 'there' });
  assert.equal(result.sent, 2);
  assert.equal(result.removed, 0);
  assert.equal(webPush.sent.length, 2);
  assert.equal(webPush.sent[0].payload.title, 'Hi');
  assert.equal(webPush.sent[0].payload.body, 'there');
});

test('sendNotification prunes subscriptions on 410 Gone', async () => {
  const webPush = fakeWebPush({
    statusFor: (sub) => (sub.endpoint === 'https://push/gone' ? 410 : 201)
  });
  const service = createPushService({ stateDir: tmpDir, webPush, now: makeFixedNow() });
  await service.subscribe({ endpoint: 'https://push/gone', keys: { p256dh: 'p', auth: 'a' } });
  await service.subscribe({ endpoint: 'https://push/ok', keys: { p256dh: 'p', auth: 'a' } });
  const result = await service.sendNotification({ title: 'Hi' });
  assert.equal(result.sent, 1);
  assert.equal(result.removed, 1);
  const status = await service.publicStatus();
  assert.equal(status.subscriberCount, 1);
  const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'push-subscriptions.json'), 'utf8'));
  assert.equal(saved.subscriptions.length, 1);
  assert.equal(saved.subscriptions[0].endpoint, 'https://push/ok');
});

test('sendNotification prunes on 404 too', async () => {
  const webPush = fakeWebPush({ statusFor: () => 404 });
  const service = createPushService({ stateDir: tmpDir, webPush, now: makeFixedNow() });
  await service.subscribe({ endpoint: 'https://push/x', keys: { p256dh: 'p', auth: 'a' } });
  const result = await service.sendNotification({ title: 'X' });
  assert.equal(result.removed, 1);
  assert.equal((await service.publicStatus()).subscriberCount, 0);
});

test('sendNotification logs but does not throw on other errors (e.g. 500)', async () => {
  const webPush = fakeWebPush({ statusFor: () => 500 });
  const service = createPushService({ stateDir: tmpDir, webPush, now: makeFixedNow() });
  await service.subscribe({ endpoint: 'https://push/err', keys: { p256dh: 'p', auth: 'a' } });
  const result = await service.sendNotification({ title: 'X' });
  assert.equal(result.sent, 0);
  assert.equal(result.removed, 0);
  assert.equal((await service.publicStatus()).subscriberCount, 1);
});

test('notificationFromServerPayload maps chat-completed', () => {
  const note = notificationFromServerPayload({ type: 'chat-completed', detail: 'All done' });
  assert.equal(note.title, '任务已完成');
  assert.equal(note.level, 'success');
  assert.match(note.body, /All done/);
});

test('notificationFromServerPayload maps approval-needed', () => {
  const note = notificationFromServerPayload({ type: 'approval-needed', label: 'Run command?' });
  assert.equal(note.level, 'warning');
  assert.equal(note.title, '需要处理');
  assert.match(note.body, /Run command/);
});

test('notificationFromServerPayload maps error', () => {
  const note = notificationFromServerPayload({ type: 'error', error: 'boom' });
  assert.equal(note.level, 'error');
  assert.equal(note.title, '任务失败');
  assert.match(note.body, /boom/);
});

test('notificationFromServerPayload returns null for unknown types', () => {
  assert.equal(notificationFromServerPayload({ type: 'something-else' }), null);
  assert.equal(notificationFromServerPayload({}), null);
});

test('notifyForPayload returns sent/removed counts and sends to subscribers', async () => {
  const webPush = fakeWebPush();
  const service = createPushService({ stateDir: tmpDir, webPush, now: makeFixedNow() });
  await service.subscribe({ endpoint: 'https://push/a', keys: { p256dh: 'p', auth: 'a' } });
  const result = await service.notifyForPayload({ type: 'chat-completed', detail: 'Done' });
  assert.deepEqual(result, { sent: 1, removed: 0 });
  assert.equal(webPush.sent.length, 1);
  assert.equal(webPush.sent[0].payload.title, '任务已完成');
});

test('notifyForPayload returns { sent:0, removed:0 } for unmapped events', async () => {
  const webPush = fakeWebPush();
  const service = createPushService({ stateDir: tmpDir, webPush, now: makeFixedNow() });
  await service.subscribe({ endpoint: 'https://push/a', keys: { p256dh: 'p', auth: 'a' } });
  const result = await service.notifyForPayload({ type: 'unrelated' });
  assert.deepEqual(result, { sent: 0, removed: 0 });
  assert.equal(webPush.sent.length, 0);
});

test('handles corrupt subscriptions file gracefully', async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'push-subscriptions.json'), '{not json', 'utf8');
  const service = createPushService({ stateDir: tmpDir, webPush: fakeWebPush(), now: makeFixedNow() });
  const status = await service.publicStatus();
  assert.equal(status.subscriberCount, 0);
});
