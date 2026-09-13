import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileSearchInternals, searchProjectFiles } from './file-search.js';

test('file search ignores generated and dependency directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-file-search-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });
  await fs.mkdir(path.join(root, '.codexmobile'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'App.jsx'), '');
  await fs.writeFile(path.join(root, '.git', 'App.jsx'), '');
  await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'App.jsx'), '');
  await fs.writeFile(path.join(root, 'dist', 'App.jsx'), '');
  await fs.writeFile(path.join(root, '.codexmobile', 'App.jsx'), '');

  const results = await searchProjectFiles({ path: root }, 'app');
  assert.deepEqual(results.map((item) => item.relativePath), ['src/App.jsx']);
});

test('file search ignore helper covers required directories', () => {
  assert.equal(fileSearchInternals.isIgnoredRelativePath('.git/config'), true);
  assert.equal(fileSearchInternals.isIgnoredRelativePath('node_modules/pkg/index.js'), true);
  assert.equal(fileSearchInternals.isIgnoredRelativePath('dist/app.js'), true);
  assert.equal(fileSearchInternals.isIgnoredRelativePath('.codexmobile/state.json'), true);
  assert.equal(fileSearchInternals.isIgnoredRelativePath('src/App.jsx'), false);
});

test('fs fallback honors root .gitignore (glob, trailing-slash dir, basename, leading /)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexmobile-file-search-gi-'));
  await fs.writeFile(
    path.join(root, '.gitignore'),
    [
      '# comment line, ignored',
      '',
      '*.log',
      'build/',
      'secrets.env',
      '/credentials.json'
    ].join('\n')
  );
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'build', 'output'), { recursive: true });
  await fs.mkdir(path.join(root, 'nested', 'credentials.json'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'app.js'), '');
  await fs.writeFile(path.join(root, 'src', 'app.log'), '');
  await fs.writeFile(path.join(root, 'build', 'output', 'app.txt'), '');
  await fs.writeFile(path.join(root, 'secrets.env'), '');
  await fs.writeFile(path.join(root, 'credentials.json'), '');
  await fs.writeFile(path.join(root, 'README.md'), '');

  const files = await fileSearchInternals.listFilesWithFs(root);

  assert.ok(files.includes('src/app.js'), 'plain source file kept');
  assert.ok(files.includes('README.md'), 'top-level readme kept');
  assert.ok(!files.includes('src/app.log'), '*.log glob excludes nested matches');
  assert.ok(!files.some((p) => p.startsWith('build/')), 'build/ trailing-slash skips subtree');
  assert.ok(!files.includes('secrets.env'), 'unanchored basename pattern excludes file');
  assert.ok(!files.includes('credentials.json'), 'leading-/ anchors to root');
  // Nested directory literally named "credentials.json" — anchored pattern
  // only matches at root, so the nested copy is still listable (we only put
  // an empty directory there, so there is nothing to walk in; but the
  // directory itself must not have been skipped by the anchored rule).
});

test('parseGitignore tolerates blanks, comments, and skips negation rules', () => {
  const rules = fileSearchInternals.parseGitignore(
    ['# header', '', '*.log', '!keep.log', 'build/'].join('\n')
  );
  // negation rules are documented as unsupported in this fallback and are
  // silently dropped — total active rules is 2 (the *.log and build/).
  assert.equal(rules.length, 2);
});
