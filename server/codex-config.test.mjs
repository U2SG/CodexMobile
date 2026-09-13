import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// CODEX_HOME is read at module load, so point it at a fixture before importing.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexmobile-codex-config-'));
process.env.CODEX_HOME = home;
fs.writeFileSync(
  path.join(home, 'config.toml'),
  [
    'model = "gpt-5.6"',
    // TOML basic string: every backslash is escaped, and a Windows device path
    // therefore arrives as four leading backslashes.
    '[projects."\\\\\\\\?\\\\D:\\\\company\\\\dataarc-contact"]',
    'trust_level = "trusted"',
    '[projects."D:\\\\project\\\\email-service"]',
    'trust_level = "trusted"',
    // TOML literal string: no escapes, keep the text verbatim.
    "[projects.'D:\\project\\literal']",
    'trust_level = "trusted"'
  ].join('\n')
);

const { readCodexConfig } = await import('./codex-config.js');

test('readCodexConfig unescapes TOML project keys so Windows paths stay usable', async () => {
  const config = await readCodexConfig();
  const paths = config.projects.map((project) => project.path);

  assert.ok(
    paths.includes('\\\\?\\D:\\company\\dataarc-contact'),
    `device path should keep exactly one \\\\?\\ prefix, got ${JSON.stringify(paths)}`
  );
  assert.ok(paths.includes('D:\\project\\email-service'), 'escaped separators collapse to single backslashes');
  assert.ok(paths.includes('D:\\project\\literal'), 'literal strings stay verbatim');
  assert.equal(config.model, 'gpt-5.6');
});

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
