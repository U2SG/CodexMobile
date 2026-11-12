// Map unified-diff output lines to real file line numbers, so a quote or a
// review comment can say "第 42-45 行" of the file instead of the position
// inside the diff text (which means nothing to the agent).

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function classifyDiffLine(line) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'meta';
  if (line.startsWith('\\')) return 'meta'; // "\ No newline at end of file"
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

// [{ kind, oldLine, newLine }] per diff line; numbers are null where they
// do not apply (meta/hunk rows, the missing side of an add or delete).
export function annotateDiffLines(lines) {
  let oldLine = null;
  let newLine = null;
  return lines.map((line) => {
    const kind = classifyDiffLine(line);
    if (kind === 'hunk') {
      const match = HUNK.exec(line);
      oldLine = match ? Number(match[1]) : null;
      newLine = match ? Number(match[2]) : null;
      return { kind, oldLine: null, newLine: null };
    }
    if (kind === 'meta' || oldLine === null) return { kind, oldLine: null, newLine: null };
    if (kind === 'add') return { kind, oldLine: null, newLine: newLine++ };
    if (kind === 'del') return { kind, oldLine: oldLine++, newLine: null };
    return { kind, oldLine: oldLine++, newLine: newLine++ };
  });
}

const MAX_LABEL_RUNS = 3;

// "第 36 行、第 52-54 行": a range that crosses hunks lists each contiguous
// run instead of one span covering lines that are not in the selection.
function spanLabel(numbers) {
  if (!numbers.length) return '';
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const runs = [];
  for (const n of sorted) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  const parts = runs.slice(0, MAX_LABEL_RUNS).map(([a, b]) => (a === b ? `第 ${a} 行` : `第 ${a}-${b} 行`));
  return parts.join('、') + (runs.length > MAX_LABEL_RUNS ? ' 等' : '');
}

// Human label for diff rows [start, end]: new-file numbers when the range
// touches the new file, otherwise (only deleted rows) the old numbers.
export function describeDiffRange(annotated, start, end) {
  const rows = annotated.slice(Math.min(start, end), Math.max(start, end) + 1);
  const newNumbers = rows.map((row) => row.newLine).filter((n) => n != null);
  if (newNumbers.length) return spanLabel(newNumbers);
  const oldNumbers = rows.map((row) => row.oldLine).filter((n) => n != null);
  return oldNumbers.length ? `原${spanLabel(oldNumbers)}（已删除）` : '';
}

function quoteRef(item) {
  const ref = item.commit ? `${item.file}#${String(item.commit).slice(0, 7)}` : item.file;
  return [ref, item.rangeLabel].filter(Boolean).join(' ');
}

function fenced(text) {
  return ['```diff', String(text || '').replace(/\s+$/, ''), '```'].join('\n');
}

export function formatDiffQuote(selection) {
  return [`> 引自 ${quoteRef(selection)}：`, fenced(selection.text)].join('\n');
}

export function formatReviewMessage(comments) {
  const blocks = comments.map((comment, index) => [
    `${index + 1}. ${quoteRef(comment)}`,
    fenced(comment.text),
    `意见：${comment.body.trim()}`
  ].join('\n'));
  return ['请按下面的代码批注修改：', ...blocks].join('\n\n');
}
