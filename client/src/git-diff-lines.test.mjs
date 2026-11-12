import assert from 'node:assert/strict';
import test from 'node:test';

import { annotateDiffLines, describeDiffRange, formatDiffQuote, formatReviewMessage } from './git-diff-lines.js';

const diff = [
  'diff --git a/src/a.js b/src/a.js',
  'index 111..222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -10,4 +10,5 @@ function f() {',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' return a;',
  '\\ No newline at end of file',
  '@@ -40,2 +41,2 @@',
  ' x();',
  '-y();'
];

test('maps diff rows to old/new file line numbers per hunk', () => {
  const rows = annotateDiffLines(diff);
  assert.deepEqual(rows.slice(4, 10).map((r) => [r.kind, r.oldLine, r.newLine]), [
    ['hunk', null, null],
    ['ctx', 10, 10],
    ['del', 11, null],
    ['add', null, 11],
    ['add', null, 12],
    ['ctx', 12, 13]
  ]);
  assert.equal(rows[10].kind, 'meta');
  assert.deepEqual([rows[12].oldLine, rows[12].newLine], [40, 41]);
  assert.deepEqual([rows[13].oldLine, rows[13].newLine], [41, null]);
});

test('labels a range by new-file lines, or old lines when only deletions', () => {
  const rows = annotateDiffLines(diff);
  assert.equal(describeDiffRange(rows, 6, 8), '第 11-12 行');
  assert.equal(describeDiffRange(rows, 9, 5), '第 10-13 行');
  assert.equal(describeDiffRange(rows, 6, 6), '原第 11 行（已删除）');
  assert.equal(describeDiffRange(rows, 0, 3), '');
  // Crossing hunks lists each run instead of one misleading span.
  assert.equal(describeDiffRange(rows, 8, 12), '第 12-13 行、第 41 行');
});

test('formats a single quote and a numbered review', () => {
  assert.equal(
    formatDiffQuote({ file: 'src/a.js', commit: 'abcdef123', rangeLabel: '第 11 行', text: '+const b = 3;\n' }),
    '> 引自 src/a.js#abcdef1 第 11 行：\n```diff\n+const b = 3;\n```'
  );
  const message = formatReviewMessage([
    { file: 'src/a.js', rangeLabel: '第 11-12 行', text: '+const b = 3;', body: ' 改回 2 ' },
    { file: 'src/b.js', rangeLabel: '第 3 行', text: ' x();', body: '加注释' }
  ]);
  assert.match(message, /^请按下面的代码批注修改：/);
  assert.match(message, /1\. src\/a\.js 第 11-12 行\n```diff\n\+const b = 3;\n```\n意见：改回 2/);
  assert.match(message, /2\. src\/b\.js 第 3 行/);
});
