import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAppServerTransport } from './codex-app-server.js';

test('resolveAppServerTransport is strict and unavailable without a desktop socket', () => {
  const transport = resolveAppServerTransport({
    CODEXMOBILE_CODEX_APP_SERVER_SOCK: '/tmp/codexmobile-missing.sock'
  });

  assert.equal(transport.strict, true);
  assert.equal(transport.connected, false);
  assert.equal(transport.mode, 'unavailable');
  assert.match(transport.reason, /不存在|未找到|No such/i);
});

test('resolveAppServerTransport only allows isolated app-server behind an explicit dev flag', () => {
  const transport = resolveAppServerTransport({
    CODEXMOBILE_CODEX_APP_SERVER_SOCK: '/tmp/codexmobile-missing.sock',
    CODEXMOBILE_ALLOW_ISOLATED_CODEX: '1'
  }, { binaryAvailable: true });

  assert.equal(transport.strict, false);
  assert.equal(transport.connected, true);
  assert.equal(transport.mode, 'isolated-dev');
});

test('resolveAppServerTransport can use a headless local fallback when explicitly allowed', () => {
  const transport = resolveAppServerTransport({
    CODEXMOBILE_CODEX_APP_SERVER_SOCK: '/tmp/codexmobile-missing.sock'
  }, { allowHeadlessLocal: true, binaryAvailable: true });

  assert.equal(transport.strict, false);
  assert.equal(transport.connected, true);
  assert.equal(transport.mode, 'headless-local');
  assert.match(transport.reason, /后台 Codex/);
});

test('resolveAppServerTransport refuses isolated and headless modes when no codex binary is on PATH', () => {
  const baseEnv = {
    CODEXMOBILE_CODEX_APP_SERVER_SOCK: '/tmp/codexmobile-missing.sock',
    CODEXMOBILE_ALLOW_ISOLATED_CODEX: '1'
  };

  const isolated = resolveAppServerTransport(baseEnv, { binaryAvailable: false });
  assert.equal(isolated.mode, 'unavailable');
  assert.match(isolated.reason, /codex 可执行文件/);

  const headless = resolveAppServerTransport(baseEnv, {
    allowHeadlessLocal: true,
    binaryAvailable: false
  });
  assert.equal(headless.mode, 'unavailable');
  assert.match(headless.reason, /codex 可执行文件/);
});
