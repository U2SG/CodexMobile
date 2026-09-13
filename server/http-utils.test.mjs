import { strict as assert } from 'node:assert';
import http from 'node:http';
import { test } from 'node:test';
import {
  MAX_JSON_BYTES,
  htmlEscape,
  readBody,
  remoteAddress,
  sendHtml,
  sendJson
} from './http-utils.js';

function fakeRes() {
  const headers = {};
  let statusCode = 0;
  let body = '';
  let ended = false;
  return {
    writeHead(status, hdrs) {
      statusCode = status;
      Object.assign(headers, hdrs);
    },
    end(chunk = '') {
      body += chunk;
      ended = true;
    },
    get statusCode() { return statusCode; },
    get headers() { return headers; },
    get body() { return body; },
    get ended() { return ended; }
  };
}

test('sendJson writes status, content-type, no-store and JSON body', () => {
  const res = fakeRes();
  sendJson(res, 200, { ok: true, n: 1 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body, JSON.stringify({ ok: true, n: 1 }));
  assert.ok(res.ended);
});

test('sendJson handles non-200 status codes', () => {
  const res = fakeRes();
  sendJson(res, 404, { error: 'nope' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'nope' });
});

test('sendHtml writes html with cache-control', () => {
  const res = fakeRes();
  sendHtml(res, 200, '<h1>hi</h1>');
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body, '<h1>hi</h1>');
});

test('htmlEscape escapes the five standard entities', () => {
  assert.equal(htmlEscape('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('htmlEscape coerces null/undefined to empty', () => {
  assert.equal(htmlEscape(null), '');
  assert.equal(htmlEscape(undefined), '');
  assert.equal(htmlEscape(0), '0');
});

test('remoteAddress prefers x-forwarded-for first hop', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(remoteAddress(req), '203.0.113.5');
});

test('remoteAddress falls back to socket.remoteAddress', () => {
  const req = { headers: {}, socket: { remoteAddress: '192.168.1.7' } };
  assert.equal(remoteAddress(req), '192.168.1.7');
});

test('remoteAddress returns empty string when nothing available', () => {
  const req = { headers: {}, socket: {} };
  assert.equal(remoteAddress(req), '');
});

async function postBody(payload, { contentType = 'application/json' } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ body }));
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: payload
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

test('readBody parses JSON request body', async () => {
  const result = await postBody(JSON.stringify({ a: 1, b: 'two' }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.body, { a: 1, b: 'two' });
});

test('readBody returns {} for empty body', async () => {
  const result = await postBody('');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.body, {});
});

test('readBody rejects invalid JSON', async () => {
  const result = await postBody('not json {');
  assert.equal(result.status, 400);
  assert.match(result.body.error, /Invalid JSON/i);
});

test('readBody rejects bodies larger than MAX_JSON_BYTES', async () => {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    try {
      await readBody(req, { maxBytes: 1024 });
      calls.push('resolved');
      res.writeHead(200); res.end();
    } catch (error) {
      calls.push(error.message);
      try { res.writeHead(413); res.end(); } catch {}
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(8192)
    }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(calls, ['Request body too large']);
  } finally {
    server.close();
  }
});

test('MAX_JSON_BYTES exposes the documented limit', () => {
  assert.equal(typeof MAX_JSON_BYTES, 'number');
  assert.ok(MAX_JSON_BYTES > 0);
});
