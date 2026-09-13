import { strict as assert } from 'node:assert';
import http from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';

import { createPeerRoutes, parsePeerUrls } from './peer-routes.js';

let server;
let baseUrl;

function startTestServer(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const handled = await routes(req, res, {
        method: req.method,
        pathname: url.pathname,
        parts: url.pathname.split('/').filter(Boolean),
        url
      });
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not handled"}');
      }
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function call(pathName) {
  const response = await fetch(`${baseUrl}${pathName}`);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

afterEach(async () => {
  if (server) await new Promise((r) => server.close(r));
});

test('parsePeerUrls returns [] when env is empty / missing', () => {
  assert.deepEqual(parsePeerUrls(''), []);
  assert.deepEqual(parsePeerUrls(null), []);
  assert.deepEqual(parsePeerUrls('  '), []);
});

test('parsePeerUrls parses bare URLs with hostname-derived label', () => {
  const peers = parsePeerUrls('https://agent-host.example:8443');
  assert.equal(peers.length, 1);
  assert.equal(peers[0].url, 'https://agent-host.example:8443');
  assert.equal(peers[0].label, 'agent-host.example:8443');
});

test('parsePeerUrls parses Label|URL entries', () => {
  const peers = parsePeerUrls('Codex|https://agent-host.example:8443,Claude|https://agent-host.example');
  assert.equal(peers.length, 2);
  assert.equal(peers[0].label, 'Codex');
  assert.equal(peers[0].url, 'https://agent-host.example:8443');
  assert.equal(peers[1].label, 'Claude');
  assert.equal(peers[1].url, 'https://agent-host.example');
});

test('parsePeerUrls skips entries without http(s) scheme', () => {
  const peers = parsePeerUrls('not-a-url,ftp://x.example,Label|file:///etc/passwd,Good|https://ok.example');
  assert.deepEqual(peers.map((p) => p.url), ['https://ok.example']);
});

test('parsePeerUrls skips empty entries / trims whitespace', () => {
  const peers = parsePeerUrls(' , https://a.example , Label| https://b.example ,');
  assert.deepEqual(peers.map((p) => p.url), ['https://a.example', 'https://b.example']);
  assert.equal(peers[1].label, 'Label');
});

test('parsePeerUrls accepts 3-segment Label|agent|URL with agent tag', () => {
  const peers = parsePeerUrls('Claude|claude|https://a.example,Codex|codex|https://b.example');
  assert.equal(peers.length, 2);
  assert.equal(peers[0].agent, 'claude');
  assert.equal(peers[0].label, 'Claude');
  assert.equal(peers[0].url, 'https://a.example');
  assert.equal(peers[1].agent, 'codex');
});

test('parsePeerUrls ignores unknown agent values (segment merges into label)', () => {
  const peers = parsePeerUrls('Label|bogus|https://a.example');
  assert.equal(peers.length, 1);
  assert.equal(peers[0].agent, undefined);
  // Unknown middle segment becomes part of the label so the entry isn't dropped.
  assert.equal(peers[0].label, 'Label | bogus');
  assert.equal(peers[0].url, 'https://a.example');
});

test('parsePeerUrls preserves order of input', () => {
  const peers = parsePeerUrls('First|https://1.example,Second|https://2.example,Third|https://3.example');
  assert.deepEqual(peers.map((p) => p.label), ['First', 'Second', 'Third']);
});

test('GET /api/peers returns the parsed list', async () => {
  const routes = createPeerRoutes({
    peerUrlsRaw: 'Codex|https://a.example,Claude|https://b.example'
  });
  ({ srv: server, baseUrl } = await startTestServer(routes));
  const { status, body } = await call('/api/peers');
  assert.equal(status, 200);
  assert.equal(body.peers.length, 2);
  assert.equal(body.peers[0].label, 'Codex');
});

test('GET /api/peers returns empty list when env is unset', async () => {
  const routes = createPeerRoutes({});
  ({ srv: server, baseUrl } = await startTestServer(routes));
  const { status, body } = await call('/api/peers');
  assert.equal(status, 200);
  assert.deepEqual(body.peers, []);
});

test('non-matching paths return false (404 from wrapper)', async () => {
  const routes = createPeerRoutes({ peerUrlsRaw: '' });
  ({ srv: server, baseUrl } = await startTestServer(routes));
  const { status } = await call('/api/other');
  assert.equal(status, 404);
});
