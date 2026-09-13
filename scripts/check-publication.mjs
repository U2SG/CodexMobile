import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

// Publication guardrail, not a complete secret/security audit.
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const checks = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential token', /\b(?:sk-[A-Za-z0-9_-]{18,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['private tailnet host', /[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net/i],
  ['credential-bearing URL', /https?:\/\/[^\s/:]+:[^\s/@]+@/],
];
const errors = [];
for (const file of files) {
  if ((/(^|\/)\.env(?:\.|$)/.test(file) && file !== '.env.example') || /(^|\/)(?:\.codexmobile|node_modules)\//.test(file) || /\.(?:pem|pfx|p12|key|db|sqlite|log)$/i.test(file)) {
    errors.push(file + ': disallowed tracked runtime/credential file');
    continue;
  }
  const bytes = await fs.readFile(file);
  if (bytes.includes(0)) continue;
  bytes.toString('utf8').split(/\r?\n/).forEach((line, index) => {
    for (const [name, pattern] of checks) {
      if (pattern.test(line)) errors.push(file + ':' + (index + 1) + ': ' + name);
    }
    if (file === '.env.example' && /^\s*#?\s*[A-Z0-9_]*(?:API_KEY|APP_SECRET|PAIRING_CODE|MANAGEMENT_KEY|PASSPHRASE)\s*=\s*[^\s#]/.test(line)) {
      errors.push(file + ':' + (index + 1) + ': nonempty example credential');
    }
  });
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Publication guard passed: ' + files.length + ' tracked files checked. Manual review remains required.');
}
