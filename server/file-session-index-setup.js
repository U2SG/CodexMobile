// Wires the file ↔ session index against the codex + claude rollout dirs.
// Returns a ready-to-use `fileSessionIndex` instance with:
//   - mtime-windowed `listRolloutFiles` (capped at CODEXMOBILE_FILE_SESSION_INDEX_DAYS days)
//   - source-classifier that tags each indexed rollout with its agent
//   - JSON persistence under `.codexmobile/state/file-session-index.json`
//     (atomic .tmp + rename to survive crashes mid-write)
//
// Cold-start cost: parsing every rollout under ~/.codex/sessions can take
// 100s+ on an active developer's machine (measured 484 files = 101s on
// the original host). Filter by mtime to a rolling N-day window before
// reading — older sessions are essentially never the answer to "who
// recently edited this file." Override with
// CODEXMOBILE_FILE_SESSION_INDEX_DAYS for users who want broader history.
//
// Extracted from server/index.js (Batch H' wrap-up).

import fs from 'node:fs/promises';
import path from 'node:path';
import { createFileSessionIndex } from './file-session-index.js';

export function createFileSessionIndexBundle(options = {}) {
  const {
    rootDir,
    codexSessionsDir,
    claudeProjectsDir,
    days = Math.max(1, Number(process.env.CODEXMOBILE_FILE_SESSION_INDEX_DAYS) || 90),
    persistFile = 'file-session-index.json',
    now = () => Date.now()
  } = options;

  if (!rootDir) throw new Error('createFileSessionIndexBundle: rootDir is required');
  if (!codexSessionsDir) throw new Error('createFileSessionIndexBundle: codexSessionsDir is required');
  if (!claudeProjectsDir) throw new Error('createFileSessionIndexBundle: claudeProjectsDir is required');

  const persistDir = options.persistDir ?? path.join(rootDir, '.codexmobile', 'state');
  const persistPath = path.join(persistDir, persistFile);
  const codexNormalized = path.resolve(codexSessionsDir).toLowerCase();
  const claudeNormalized = path.resolve(claudeProjectsDir).toLowerCase();

  async function listRolloutFiles() {
    const cutoffMs = now() - days * 24 * 60 * 60 * 1000;
    const out = [];
    async function walk(dir) {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent-')) {
          let stat;
          try {
            stat = await fs.stat(full);
          } catch {
            continue;
          }
          if (stat.mtimeMs >= cutoffMs) {
            out.push({ path: full, mtimeMs: stat.mtimeMs });
          }
        }
      }
    }
    await walk(codexSessionsDir);
    await walk(claudeProjectsDir);
    return out;
  }

  async function loadPersistence() {
    try {
      const text = await fs.readFile(persistPath, 'utf8');
      return JSON.parse(text);
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  async function savePersistence(snapshot) {
    await fs.mkdir(persistDir, { recursive: true });
    const tmp = `${persistPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(snapshot), 'utf8');
    await fs.rename(tmp, persistPath);
  }

  function classifySourceFile(filePath) {
    if (typeof filePath !== 'string' || !filePath) return undefined;
    const normalized = path.resolve(filePath).toLowerCase();
    if (normalized.startsWith(codexNormalized)) return 'codex';
    if (normalized.startsWith(claudeNormalized)) return 'claude';
    return undefined;
  }

  const fileSessionIndex = createFileSessionIndex({
    listRolloutFiles,
    readRolloutFile: (filePath) => fs.readFile(filePath, 'utf8'),
    loadPersistence,
    savePersistence,
    classifySourceFile
  });

  const readRolloutFile = (filePath) => fs.readFile(filePath, 'utf8');

  return { fileSessionIndex, listRolloutFiles, readRolloutFile, classifySourceFile, persistPath, days };
}
