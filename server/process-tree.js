import { spawn, spawnSync } from 'node:child_process';

// With `shell: true` on Windows the child is cmd.exe wrapping an npm `.cmd`
// shim wrapping the real node/codex process. child.kill() only ends cmd.exe
// and orphans the rest, so take the whole tree down with taskkill /t.
export function killProcessTree(child, { sync = false } = {}) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    const args = ['/pid', String(child.pid), '/t', '/f'];
    if (sync) {
      spawnSync('taskkill.exe', args, { windowsHide: true, stdio: 'ignore' });
    } else {
      spawn('taskkill.exe', args, { windowsHide: true, stdio: 'ignore' }).on('error', () => null);
    }
    return;
  }
  child.kill('SIGTERM');
}
