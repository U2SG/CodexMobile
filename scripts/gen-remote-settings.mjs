#!/usr/bin/env node
// Generate a Claude `--settings` file that installs CodexMobile's PreToolUse
// approval hook for an opt-in interactive terminal session (the `cmr` /
// start-claude-remote launcher). Prints the absolute path of the written file
// on stdout; the launcher passes it to `claude --settings`.
//
// Mirrors server/codex-runner.js buildClaudeSettingsWithApprovalHook: Claude's
// --settings flag REPLACES the whole `hooks` object from lower-precedence
// sources, so we read the user + project settings and union their hooks with
// ours, rather than stomping the user's other lifecycle hooks. Existing
// entries that already point at our hook script are dropped so we never
// double-fire.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_SCRIPT = path.join(REPO_ROOT, 'bin', 'claude-approval-hook.mjs');
const HOOK_COMMAND = `node "${HOOK_SCRIPT}"`;

// Same set CodexMobile's own spawns match — state-mutating tools worth
// confirming, plus AskUserQuestion so its choice form reaches the phone.
const MATCHERS = ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'AskUserQuestion'];

function referencesOurHook(entry) {
  const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
  return hooks.some((h) => typeof h?.command === 'string' && h.command.includes('claude-approval-hook.mjs'));
}

async function readSettings(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'EISDIR') {
      console.error(`[gen-remote-settings] ignoring unreadable ${file}: ${error.message}`);
    }
    return null;
  }
}

const sources = [
  path.join(os.homedir(), '.claude', 'settings.json'),
  path.join(process.cwd(), '.claude', 'settings.json')
];

const mergedHooks = {};
for (const file of sources) {
  const parsed = await readSettings(file);
  const events = parsed?.hooks;
  if (!events || typeof events !== 'object') continue;
  for (const [eventName, entries] of Object.entries(events)) {
    if (!Array.isArray(entries)) continue;
    if (!mergedHooks[eventName]) mergedHooks[eventName] = [];
    // Drop any pre-existing entry that already points at our hook so we don't
    // double up after re-adding our canonical set below.
    for (const entry of entries) {
      if (eventName === 'PreToolUse' && referencesOurHook(entry)) continue;
      mergedHooks[eventName].push(entry);
    }
  }
}

if (!mergedHooks.PreToolUse) mergedHooks.PreToolUse = [];
for (const matcher of MATCHERS) {
  mergedHooks.PreToolUse.push({ matcher, hooks: [{ type: 'command', command: HOOK_COMMAND }] });
}

const outFile = path.join(os.tmpdir(), `codexmobile-remote-settings-${process.pid}.json`);
await fs.writeFile(outFile, JSON.stringify({ hooks: mergedHooks }), 'utf8');
process.stdout.write(outFile);
