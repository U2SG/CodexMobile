import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-auth-expiry-'));
process.env.CODEXMOBILE_HOME = home;
process.env.CODEXMOBILE_PAIRING_CODE = '246810';
delete process.env.CODEXMOBILE_DEVICE_TTL_DAYS;

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

test('devices unused past the TTL are dropped on start and their tokens rejected', async () => {
  await fs.writeFile(path.join(home, 'auth-state.json'), JSON.stringify({
    devices: [
      { id: 'old', name: 'stale-browser', tokenHash: hash('old-token'), createdAt: daysAgo(200), lastSeenAt: daysAgo(100) },
      { id: 'new', name: 'phone', tokenHash: hash('new-token'), createdAt: daysAgo(200), lastSeenAt: daysAgo(3) }
    ]
  }));
  const auth = await import('./auth.js?expiry');
  await auth.initializeAuth();

  const saved = JSON.parse(await fs.readFile(path.join(home, 'auth-state.json'), 'utf8'));
  assert.deepEqual(saved.devices.map((d) => d.id), ['new']);
  assert.equal(await auth.verifyToken('old-token'), false);
  assert.equal(await auth.verifyToken('new-token'), true);

  await fs.rm(home, { recursive: true, force: true });
});
