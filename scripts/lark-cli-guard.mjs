#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const realCli = process.env.CODEXMOBILE_REAL_LARK_CLI || 'lark-cli';
const stateDir = process.env.CODEXMOBILE_LARK_GUARD_STATE_DIR || process.cwd();
const turnId = process.env.CODEXMOBILE_TURN_ID || process.env.CODEXMOBILE_SESSION_ID || 'unknown-turn';

function argValue(flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) {
    return '';
  }
  return String(args[index + 1] || '').trim();
}

function isSlidesCreate() {
  return args[0] === 'slides' && args[1] === '+create';
}

function stateKey() {
  const title = argValue('--title') || '(untitled)';
  return `${turnId}:${title.toLowerCase()}`;
}

function redacted(value) {
  return String(value || '')
    .replace(/"appSecret"\s*:\s*"[^"]+"/gi, '"appSecret":"****"')
    .replace(/"access[_-]?token"\s*:\s*"[^"]+"/gi, '"accessToken":"****"')
    .replace(/"refresh[_-]?token"\s*:\s*"[^"]+"/gi, '"refreshToken":"****"')
    .replace(/\b(u|ur|t)-[A-Za-z0-9._-]{20,}\b/g, '$1-[hidden]')
    .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-[hidden]');
}

async function readState(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
}

function isPreCreateValidationFailure(text) {
  return /--slides invalid json|invalid json, must be an array|unknown flag|required flag|auth|permission|forbidden|unauthorized|no user logged in|network|econn|timeout/i.test(text);
}

async function maybeBlockDuplicate(stateFile) {
  if (!isSlidesCreate()) {
    return false;
  }
  const state = await readState(stateFile);
  const key = stateKey();
  const existing = state[key];
  if (!existing?.attemptedAt) {
    return false;
  }

  const title = argValue('--title') || '(untitled)';
  const hint = {
    ok: false,
    error: {
      type: 'codexmobile_duplicate_slides_create_blocked',
      message: `This turn already ran slides +create for "${title}". Do not create another PPT. Reuse the previous xml_presentation_id and repair/append pages on the same presentation.`,
      previous: {
        title,
        attemptedAt: existing.attemptedAt,
        xmlPresentationId: existing.xmlPresentationId || '',
        output: existing.output || ''
      },
      nextStep: 'Run lark-cli slides xml_presentations get, then use xml_presentation.slide.create or +replace-slide on the existing PPT.'
    }
  };
  process.stderr.write(`${JSON.stringify(hint, null, 2)}\n`);
  process.exitCode = 24;
  return true;
}

function extractPresentationId(text) {
  const value = String(text || '');
  const jsonMatch = value.match(/"xml_presentation_id"\s*:\s*"([^"]+)"/i);
  if (jsonMatch) {
    return jsonMatch[1];
  }
  const urlMatch = value.match(/\/slides\/([A-Za-z0-9_-]+)/i);
  return urlMatch?.[1] || '';
}

async function recordCreateAttempt(stateFile, stdout, stderr, code) {
  if (!isSlidesCreate()) {
    return;
  }
  const combined = `${stdout}\n${stderr}`;
  const xmlPresentationId = extractPresentationId(combined);
  if (code !== 0 && !xmlPresentationId && isPreCreateValidationFailure(combined)) {
    return;
  }
  const state = await readState(stateFile);
  const key = stateKey();
  state[key] = {
    attemptedAt: new Date().toISOString(),
    title: argValue('--title') || '(untitled)',
    xmlPresentationId,
    output: redacted(combined).slice(-1600)
  };
  await writeState(stateFile, state);
}

function larkCliSpawnCommand() {
  if (process.platform === 'win32' && /\.cmd$|\.bat$/i.test(realCli)) {
    const commandLine = ['call', windowsCmdQuote(realCli), ...args.map(windowsCmdQuote)].join(' ');
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/c', commandLine],
      windowsVerbatimArguments: true
    };
  }
  return {
    command: realCli,
    args,
    windowsVerbatimArguments: false
  };
}

function windowsCmdQuote(value) {
  return `"${String(value || '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

async function main() {
  const stateFile = path.join(stateDir, 'lark-slides-create-guard.json');
  if (await maybeBlockDuplicate(stateFile)) {
    return;
  }

  const cli = larkCliSpawnCommand();
  const child = spawn(cli.command, cli.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEXMOBILE_LARK_GUARD_CHILD: '1'
    },
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: cli.windowsVerbatimArguments
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stdout += text;
  });
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderr += text;
  });
  child.on('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
  child.on('close', async (code) => {
    if (stdout) {
      process.stdout.write(stdout);
    }
    if (stderr) {
      process.stderr.write(stderr);
    }
    await recordCreateAttempt(stateFile, stdout, stderr, code || 0).catch((error) => {
      process.stderr.write(`[codexmobile-lark-guard] failed to record state: ${error.message}\n`);
    });
    process.exitCode = code || 0;
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
