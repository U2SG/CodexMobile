import assert from 'node:assert/strict';
import test from 'node:test';
import { quoteCmdArg, shellSpawnArgs } from './shell-command.js';

test('quoteCmdArg quotes only when cmd.exe would split or reinterpret', () => {
  assert.equal(quoteCmdArg('--model'), '--model');
  assert.equal(quoteCmdArg('C:\Program Files\codex.exe'), '"C:\Program Files\codex.exe"');
  assert.equal(quoteCmdArg('a|b'), '"a|b"');
  assert.equal(quoteCmdArg('x>y'), '"x>y"');
  assert.equal(quoteCmdArg(''), '""');
});

test('quoteCmdArg refuses values cmd.exe cannot carry intact', () => {
  for (const value of ['line1\nline2', 'say "hi"', '%PATH%']) {
    assert.throws(() => quoteCmdArg(value));
  }
});

test('shellSpawnArgs builds one quoted command line on Windows and passes no args array', () => {
  const launch = shellSpawnArgs('claude.cmd', ['-p', '--settings', 'C:\Temp Dir\s.json']);
  if (process.platform === 'win32') {
    assert.deepEqual(launch, { command: 'claude.cmd -p --settings "C:\Temp Dir\s.json"', args: [], shell: true });
  } else {
    assert.deepEqual(launch, { command: 'claude.cmd', args: ['-p', '--settings', 'C:\Temp Dir\s.json'], shell: false });
  }
});
