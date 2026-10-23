import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The Codex and Claude services are separate processes sharing one
// auth-state.json. Two module instances (distinct import URLs) model that:
// each has its own in-memory state, both point at the same file.
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-auth-'));
process.env.CODEXMOBILE_HOME = home;
process.env.CODEXMOBILE_PAIRING_CODE = '246810';
const codexService = await import('./auth.js?service=codex');
const claudeService = await import('./auth.js?service=claude');

test('pairing on one service survives the other service writing its state', async () => {
  await codexService.initializeAuth();
  await claudeService.initializeAuth();

  const onClaude = await claudeService.pairDevice({ code: '246810', deviceName: 'phone-on-claude' });
  const onCodex = await codexService.pairDevice({ code: '246810', deviceName: 'phone-on-codex' });

  const saved = JSON.parse(await fs.readFile(path.join(home, 'auth-state.json'), 'utf8'));
  assert.deepEqual(saved.devices.map((d) => d.name).sort(), ['phone-on-claude', 'phone-on-codex']);

  // Each service accepts the device paired on the other, without a restart.
  assert.equal(await codexService.verifyToken(onClaude.token), true);
  assert.equal(await claudeService.verifyToken(onCodex.token), true);
  assert.equal(await codexService.verifyToken('not-a-token'), false);

  await fs.rm(home, { recursive: true, force: true });
});
