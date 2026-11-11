import { spawn } from 'node:child_process';

// A Mac that idles to sleep mid-turn stalls the agent and the phone loses the
// stream. While any turn runs (or waits on an approval), hold a
// `caffeinate -i` assertion; release it when everything is done. `-w <pid>`
// ties the assertion to this server so a crash never leaves the Mac awake.
// macOS only, opt-in with CODEXMOBILE_KEEP_AWAKE=1. Idle sleep only: closing
// the lid on battery still sleeps.
export function createKeepAwake({
  enabled = process.env.CODEXMOBILE_KEEP_AWAKE === '1',
  platform = process.platform,
  spawnImpl = spawn,
  pid = process.pid,
  log = (message) => console.log(message)
} = {}) {
  const active = enabled && platform === 'darwin';
  let child = null;

  function update(busy) {
    if (!active) return false;
    if (busy && !child) {
      const proc = spawnImpl('caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore' });
      child = proc;
      proc.on('exit', () => {
        if (child === proc) child = null;
      });
      proc.on('error', (error) => {
        if (child === proc) child = null;
        log(`[keep-awake] caffeinate unavailable: ${error.message}`);
      });
      log('[keep-awake] holding the Mac awake while turns run');
    } else if (!busy && child) {
      child.kill();
      child = null;
      log('[keep-awake] released');
    }
    return Boolean(child);
  }

  return { update, isHolding: () => Boolean(child) };
}
