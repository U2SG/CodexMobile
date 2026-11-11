import assert from 'node:assert/strict';
import test from 'node:test';

import { createNtfyNotifier } from './ntfy-notifier.js';

function fakeFetch(status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status < 400, status };
  };
  return { fetchImpl, calls };
}

test('is disabled without a url', () => {
  assert.equal(createNtfyNotifier({ url: '' }), null);
});

test('rejects a url without a single topic segment', () => {
  assert.throws(() => createNtfyNotifier({ url: 'http://127.0.0.1:2586' }), /topic/);
  assert.throws(() => createNtfyNotifier({ url: 'http://127.0.0.1:2586/a/b' }), /topic/);
});

test('publishes JSON to the server root with topic, priority and auth', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const notify = createNtfyNotifier({ url: 'https://ntfy.example.test:2587/codexmobile', token: 'tk', fetchImpl });
  await notify({ title: '需要处理 · Claude', body: '重构登录', level: 'warning' });
  assert.equal(calls[0].url, 'https://ntfy.example.test:2587/');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tk');
  assert.deepEqual(calls[0].body, {
    topic: 'codexmobile',
    title: '需要处理 · Claude',
    message: '重构登录',
    priority: 4,
    tags: ['warning']
  });
});

test('surfaces a non-2xx response as an error', async () => {
  const { fetchImpl } = fakeFetch(403);
  const notify = createNtfyNotifier({ url: 'https://ntfy.example.test/codexmobile', fetchImpl });
  await assert.rejects(notify({ title: 't', body: 'b' }), /403/);
});
