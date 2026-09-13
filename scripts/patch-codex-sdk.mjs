import fs from 'node:fs';
import path from 'node:path';

const sdkPath = path.resolve('node_modules', '@openai', 'codex-sdk', 'dist', 'index.js');

if (!fs.existsSync(sdkPath)) {
  console.warn(`[patch-codex-sdk] skipped, not found: ${sdkPath}`);
  process.exit(0);
}

let source = fs.readFileSync(sdkPath, 'utf8');
let modified = false;

// Patch 1: windowsHide for spawned codex CLI
const spawnTarget = `const child = spawn(this.executablePath, commandArgs, {
      env,
      signal: args.signal
    });`;
const spawnReplacement = `const child = spawn(this.executablePath, commandArgs, {
      env,
      signal: args.signal,
      windowsHide: true
    });`;
if (source.includes(spawnReplacement)) {
  console.log('[patch-codex-sdk] spawn options already patched');
} else if (source.includes(spawnTarget)) {
  source = source.replace(spawnTarget, spawnReplacement);
  modified = true;
  console.log('[patch-codex-sdk] patched Codex SDK spawn options');
} else {
  console.warn('[patch-codex-sdk] spawn snippet not found; SDK may have changed');
}

// Patch 2: tolerate non-JSON lines on the codex CLI stdout. Codex CLI invokes
// taskkill /T on Windows without redirecting its stdout to NUL when killing
// child shells; the GBK message "成功: 已终止 PID ... 子进程" leaks into the
// stream and triggers JSON.parse to throw. Skip such lines instead of failing
// the whole turn.
const parseTarget = `for await (const item of generator) {
        let parsed;
        try {
          parsed = JSON.parse(item);
        } catch (error) {
          throw new Error(\`Failed to parse item: \${item}\`, { cause: error });
        }`;
// Previous patch form: always warned on non-JSON stdout, which produced
// spammy "skipping non-JSON stdout line: SUCCESS: The process with PID ..."
// log entries every time we aborted a turn (taskkill /T's SUCCESS lines leak
// into stdout on Windows). New form silently swallows that exact pattern.
const parseReplacementOld = `for await (const item of generator) {
        let parsed;
        try {
          parsed = JSON.parse(item);
        } catch (error) {
          if (typeof item === 'string' && item.trim() && !item.trim().startsWith('{')) {
            console.warn('[codex-sdk] skipping non-JSON stdout line:', item.slice(0, 200));
            continue;
          }
          throw new Error(\`Failed to parse item: \${item}\`, { cause: error });
        }`;
const parseReplacement = `for await (const item of generator) {
        let parsed;
        try {
          parsed = JSON.parse(item);
        } catch (error) {
          if (typeof item === 'string' && item.trim() && !item.trim().startsWith('{')) {
            const trimmed = item.trim();
            // taskkill /T SUCCESS lines on Windows abort are expected noise.
            if (!/^SUCCESS:.*has been terminated/i.test(trimmed) &&
                !/^成功:.*已终止/.test(trimmed)) {
              console.warn('[codex-sdk] skipping non-JSON stdout line:', trimmed.slice(0, 200));
            }
            continue;
          }
          throw new Error(\`Failed to parse item: \${item}\`, { cause: error });
        }`;
if (source.includes(parseReplacement)) {
  console.log('[patch-codex-sdk] parser tolerance already patched');
} else if (source.includes(parseReplacementOld)) {
  source = source.replace(parseReplacementOld, parseReplacement);
  modified = true;
  console.log('[patch-codex-sdk] upgraded parser tolerance to silence taskkill noise');
} else if (source.includes(parseTarget)) {
  source = source.replace(parseTarget, parseReplacement);
  modified = true;
  console.log('[patch-codex-sdk] patched Codex SDK to skip non-JSON stdout lines');
} else {
  console.warn('[patch-codex-sdk] parser snippet not found; SDK may have changed');
}

if (modified) {
  fs.writeFileSync(sdkPath, source, 'utf8');
}
