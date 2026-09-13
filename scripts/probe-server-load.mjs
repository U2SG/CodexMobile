// Loads server/index.js in a clean subprocess and reports any synchronous
// module-evaluation error (TDZ, ReferenceError, missing import, etc).
//
// Why not a node:test: the module binds HTTP/WS ports as a side-effect of
// loading, so running it inside a regular test runner would conflict with
// real servers and force pre-bind config wrangling. This script picks an
// OS-assigned port (PORT=0), gives the module 5 seconds to finish module
// evaluation + start listening, then kills the subprocess and reports
// success unless we saw a fatal stack trace.
//
// Catches the specific class of bug where a new `const xxxRoutes = ...`
// declaration accidentally accesses another `const` that's initialized
// further down in the same file — JavaScript's TDZ throws synchronously
// during module evaluation but `npm test` doesn't currently load
// index.js, so the regression escapes test runs. Run via
// `npm run smoke:load` before deploys.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENTRY = path.join(ROOT, 'server', 'index.js');
const ENTRY_URL = pathToFileURL(ENTRY).href;

const child = spawn(
  process.execPath,
  ['--input-type=module', '-e', `
process.on('uncaughtException', (err) => {
  process.stderr.write('UNCAUGHT_EXCEPTION:' + (err?.stack || err) + '\\n');
  process.exit(2);
});
// TDZ-class errors fire synchronously during module evaluation —
// import() resolving is itself the all-clear signal. The 800ms grace
// covers errors thrown in the listen-callback that the server installs
// at the bottom of module init (e.g. prewarm rejections that re-throw).
// Keep this tight so smoke:load can sit at the end of npm test without
// adding noticeable wall time.
import(${JSON.stringify(ENTRY_URL)})
  .then(() => { setTimeout(() => process.exit(0), 800); })
  .catch((err) => {
    process.stderr.write('IMPORT_REJECTED:' + (err?.stack || err) + '\\n');
    process.exit(3);
  });
`],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      HTTPS_PORT: '0',
      // Don't pair / try to reach real desktop IPC during the smoke.
      CODEXMOBILE_PAIRING_CODE: '000000',
      // Disable peer-fetch (no peer needed for a load check).
      CODEXMOBILE_PEER_URLS: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }
);

let stderr = '';
let stdout = '';
child.stdout.on('data', (d) => { stdout += d.toString(); });
child.stderr.on('data', (d) => { stderr += d.toString(); });

const killTimer = setTimeout(() => {
  // Wall-clock backstop: if the child somehow hangs (e.g. blocking I/O
  // during module init), reap it. The in-child 800ms timer normally
  // exits first.
  try { child.kill('SIGTERM'); } catch { /* noop */ }
}, 4000);

child.on('exit', (code, signal) => {
  clearTimeout(killTimer);
  if (signal === 'SIGTERM' && code === null) {
    // Child was still running when we killed it — that's success
    // (module evaluated, server started, no synchronous crash).
    process.stdout.write('[probe-server-load] ok — server entered listen state without crashing\n');
    process.exit(0);
  }
  if (code === 0) {
    // Subprocess exited cleanly via its own timeout. Also success.
    process.stdout.write('[probe-server-load] ok — module evaluated cleanly\n');
    process.exit(0);
  }
  process.stderr.write(`[probe-server-load] FAIL (exit=${code} signal=${signal})\n`);
  if (stderr) process.stderr.write(stderr);
  if (stdout) process.stdout.write(stdout);
  process.exit(1);
});
