import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createKeepAwake } from './keep-awake.js';

function fakeSpawn() {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    const proc = new EventEmitter();
    proc.killed = false;
    proc.kill = () => { proc.killed = true; proc.emit('exit', 0); };
    calls.push({ cmd, args, proc });
    return proc;
  };
  return { spawnImpl, calls };
}

const quiet = () => {};

test('holds one caffeinate tied to the server pid while busy and releases when idle', () => {
  const { spawnImpl, calls } = fakeSpawn();
  const keepAwake = createKeepAwake({ enabled: true, platform: 'darwin', spawnImpl, pid: 4242, log: quiet });
  assert.equal(keepAwake.update(true), true);
  assert.equal(keepAwake.update(true), true);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].cmd, calls[0].args], ['caffeinate', ['-i', '-w', '4242']]);
  assert.equal(keepAwake.update(false), false);
  assert.equal(calls[0].proc.killed, true);
  keepAwake.update(true);
  assert.equal(calls.length, 2, 'a new turn takes a new assertion');
});

test('does nothing unless enabled on macOS', () => {
  const { spawnImpl, calls } = fakeSpawn();
  createKeepAwake({ enabled: false, platform: 'darwin', spawnImpl, log: quiet }).update(true);
  createKeepAwake({ enabled: true, platform: 'linux', spawnImpl, log: quiet }).update(true);
  assert.equal(calls.length, 0);
});

test('forgets a caffeinate that exited or failed to start', () => {
  const { spawnImpl, calls } = fakeSpawn();
  const keepAwake = createKeepAwake({ enabled: true, platform: 'darwin', spawnImpl, log: quiet });
  keepAwake.update(true);
  calls[0].proc.emit('error', new Error('ENOENT'));
  assert.equal(keepAwake.isHolding(), false);
  keepAwake.update(true);
  assert.equal(calls.length, 2);
});
