#!/usr/bin/env node
// End-to-end probe: spawn `claude` with the inline --settings hook and our
// real hook script, listen for the hook's POST on a localhost responder,
// and reply 'allow' so the tool call proceeds. Exits 0 only when the hook
// actually fired AND Claude completed.
//
// Run with:
//   CODEXMOBILE_CLAUDE_USE_HOOKS=1 node scripts/probe-claude-hook.mjs

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'claude-approval-hook.mjs');
const SECRET = 'probe-secret-' + Math.random().toString(36).slice(2);

// Claude writes the probe's rollout under ~/.claude/projects/<cwd-encoded>/<uuid>.jsonl.
// We snapshot the dir before spawn and delete any newly-created files after exit so
// the probe doesn't leave duplicate-titled entries in the sidebar's session list.
function claudeProjectsDirFor(cwd) {
  const encoded = path.resolve(cwd).replace(/[\\/:]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded);
}
async function snapshotJsonlFiles(dir) {
  try {
    const entries = await fs.readdir(dir);
    return new Set(entries.filter((name) => name.endsWith('.jsonl')));
  } catch {
    return new Set();
  }
}
async function deleteNewJsonlFiles(dir, before) {
  try {
    const entries = await fs.readdir(dir);
    for (const name of entries) {
      if (!name.endsWith('.jsonl') || before.has(name)) continue;
      await fs.unlink(path.join(dir, name)).catch(() => null);
      console.log(`[probe] cleaned up leftover session: ${name}`);
    }
  } catch {
    // dir gone or unreadable — nothing to clean.
  }
}

let hookHits = 0;
const server = http.createServer(async (req, res) => {
  if (req.url !== '/api/internal/claude-approval' || req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  if (req.headers['x-claude-hook-secret'] !== SECRET) {
    res.writeHead(401).end();
    console.error('[probe] BAD SECRET on hook POST');
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  hookHits += 1;
  console.log(`[probe] hook POST #${hookHits} tool=${body.toolName} input=${JSON.stringify(body.toolInput).slice(0, 120)}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ permissionDecision: 'allow', permissionDecisionReason: 'probe auto-allow' }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const hookUrl = `http://127.0.0.1:${port}/api/internal/claude-approval`;
console.log(`[probe] responder up on ${hookUrl}`);

const settings = {
  hooks: {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${HOOK_SCRIPT}"` }] }]
  }
};
const settingsFile = path.join(os.tmpdir(), `probe-claude-settings-${Date.now()}.json`);
await fs.writeFile(settingsFile, JSON.stringify(settings), 'utf8');

const args = [
  '-p',
  '--output-format=json',
  '--permission-mode', 'default',
  '--model', 'sonnet',
  '--settings', settingsFile
];

const prompt = '请用 Bash 工具执行 `echo HOOK_PROBE_OK` 然后只回复一句话告诉我你看到了什么。';

const projectsDir = claudeProjectsDirFor(process.cwd());
const jsonlSnapshot = await snapshotJsonlFiles(projectsDir);

const child = spawn(process.platform === 'win32' ? 'claude.cmd' : 'claude', args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    CODEXMOBILE_HOOK_URL: hookUrl,
    CODEXMOBILE_HOOK_SECRET: SECRET,
    CODEXMOBILE_TURN_ID: 'probe-turn',
    CODEXMOBILE_SESSION_ID: 'probe-session'
  }
});
child.stdin.end(prompt, 'utf8');

let out = '';
let err = '';
child.stdout.on('data', (c) => { out += c.toString(); });
child.stderr.on('data', (c) => { err += c.toString(); });

const code = await new Promise((resolve) => child.once('close', resolve));
server.close();
fs.unlink(settingsFile).catch(() => null);
await deleteNewJsonlFiles(projectsDir, jsonlSnapshot);

console.log(`[probe] claude exit=${code}`);
console.log(`[probe] stdout tail:\n${out.slice(-500)}`);
if (err.trim()) console.log(`[probe] stderr tail:\n${err.slice(-500)}`);
console.log(`[probe] hook hits total: ${hookHits}`);
process.exit(hookHits > 0 && code === 0 ? 0 : 1);
