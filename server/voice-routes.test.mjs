import { strict as assert } from 'node:assert';
import http from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { createVoiceRoutes } from './voice-routes.js';

let server;
let baseUrl;
let calls;
let transcribeImpl;
let synthesizeImpl;
let readVoiceUploadImpl;

function startTestServer(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const ctx = { method: req.method, pathname: url.pathname };
      const handled = await routes(req, res, ctx);
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not handled' }));
      }
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

beforeEach(async () => {
  calls = { transcribe: [], synthesize: [], voiceUpload: 0 };
  transcribeImpl = async () => ({ text: 'hello world', provider: 'mock', model: 'm-1' });
  synthesizeImpl = async () => ({
    data: Buffer.from('audio-bytes'),
    mimeType: 'audio/mpeg',
    provider: 'mock',
    model: 's-1',
    voice: 'v1'
  });
  readVoiceUploadImpl = async () => ({ data: Buffer.from('audio-bytes'), mimeType: 'audio/webm' });
  const routes = createVoiceRoutes({
    transcribeAudio: async (audio, config) => {
      calls.transcribe.push({ audio, config });
      return await transcribeImpl(audio, config);
    },
    synthesizeSpeech: async (text, config) => {
      calls.synthesize.push({ text, config });
      return await synthesizeImpl(text, config);
    },
    readVoiceUpload: async (req) => {
      calls.voiceUpload += 1;
      return await readVoiceUploadImpl(req);
    },
    getCacheSnapshot: () => ({ config: { provider: 'codex', model: 'gpt-5.5' } }),
    remoteAddress: () => '127.0.0.1'
  });
  ({ srv: server, baseUrl } = await startTestServer(routes));
});

afterEach(() => new Promise((resolve) => server.close(resolve)));

test('POST /api/voice/transcribe returns the text payload', async () => {
  const res = await fetch(`${baseUrl}/api/voice/transcribe`, {
    method: 'POST',
    body: 'whatever'
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.text, 'hello world');
  assert.ok(Number.isFinite(body.durationMs));
  assert.equal(calls.voiceUpload, 1);
  assert.equal(calls.transcribe.length, 1);
});

test('POST /api/voice/transcribe sanitizes sk-* tokens out of error messages', async () => {
  transcribeImpl = async () => {
    const err = new Error('upstream sk-abc123XYZ rejected');
    err.statusCode = 401;
    err.providerHost = 'mock-host';
    throw err;
  };
  const res = await fetch(`${baseUrl}/api/voice/transcribe`, { method: 'POST', body: 'x' });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.ok(body.error.includes('sk-[hidden]'));
  assert.ok(!body.error.includes('sk-abc123XYZ'));
});

test('POST /api/voice/transcribe defaults statusCode to 502 when not set', async () => {
  transcribeImpl = async () => { throw new Error('boom'); };
  const res = await fetch(`${baseUrl}/api/voice/transcribe`, { method: 'POST', body: 'x' });
  assert.equal(res.status, 502);
});

test('POST /api/voice/speech streams the audio buffer with the correct content-type', async () => {
  const res = await fetch(`${baseUrl}/api/voice/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好' })
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(res.headers.get('x-codexmobile-duration-ms'));
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.toString('utf8'), 'audio-bytes');
  assert.deepEqual(calls.synthesize[0].text, '你好');
});

test('POST /api/voice/speech sanitizes sk-* tokens in error messages', async () => {
  synthesizeImpl = async () => { throw new Error('sk-leaked-XYZ failed'); };
  const res = await fetch(`${baseUrl}/api/voice/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x' })
  });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.ok(body.error.includes('sk-[hidden]'));
  assert.ok(!body.error.includes('sk-leaked-XYZ'));
});

test('returns false (passthrough) for unrelated paths', async () => {
  const res = await fetch(`${baseUrl}/api/other`);
  assert.equal(res.status, 404);
});
