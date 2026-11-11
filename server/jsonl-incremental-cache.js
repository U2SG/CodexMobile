import fs from 'node:fs/promises';
import fsSync from 'node:fs';

const NEWLINE = 0x0a;

// Append-only JSONL files (Claude session logs, legacy codex histories) are
// re-read on every poll. Parsing an 80MB file every 900ms is the dominant
// server cost, so this keeps per-file parse state and only feeds the rows
// appended since the previous read into `applyEntry`. A shrunk or replaced
// file (size below the consumed offset, or a new inode) starts over.
export function createJsonlIncrementalCache({ createState, applyEntry, maxEntries = 8 }) {
  const entries = new Map();

  function touch(filePath, entry) {
    entries.delete(filePath);
    entries.set(filePath, entry);
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
  }

  async function consumeAppended(entry, filePath, size) {
    if (size <= entry.offset) return;
    const stream = fsSync.createReadStream(filePath, { start: entry.offset, end: size - 1 });
    let pending = Buffer.alloc(0);
    for await (const chunk of stream) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let lineStart = 0;
      let newline = pending.indexOf(NEWLINE, lineStart);
      while (newline !== -1) {
        applyLine(entry, pending.toString('utf8', lineStart, newline));
        lineStart = newline + 1;
        newline = pending.indexOf(NEWLINE, lineStart);
      }
      entry.offset += lineStart;
      pending = pending.subarray(lineStart);
    }
    // A trailing row without a newline is either complete (writer omitted the
    // final newline) or still being written. Consume it only if it parses.
    if (pending.length) {
      const text = pending.toString('utf8');
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      entry.offset += pending.length;
      applyEntry(entry.state, parsed);
    }
  }

  function applyLine(entry, line) {
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // Skip malformed rows.
    }
    applyEntry(entry.state, parsed);
  }

  // `context` is passed to createState when a file's parse starts over.
  async function read(filePath, context) {
    const stat = await fs.stat(filePath);
    let entry = entries.get(filePath);
    if (!entry || entry.ino !== stat.ino || stat.size < entry.offset) {
      entry = { ino: stat.ino, offset: 0, state: createState(context), queue: Promise.resolve() };
    }
    touch(filePath, entry);
    // Serialize reads per file so two concurrent polls never apply the same
    // byte range twice.
    const run = entry.queue.then(() => consumeAppended(entry, filePath, stat.size));
    entry.queue = run.catch(() => {});
    try {
      await run;
    } catch (error) {
      entries.delete(filePath);
      throw error;
    }
    return entry.state;
  }

  return { read, clear: () => entries.clear() };
}
