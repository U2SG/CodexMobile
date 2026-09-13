import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10MB
const DIFF_TRUNCATE_BYTES = 1 * 1024 * 1024; // 1MB
const TRUNCATE_MARKER = '\n\n[... diff truncated at 1MB ...]\n';
const MAX_MESSAGE_LENGTH = 4000;

// Disallowed substrings in any argument we pass to git. These cover
// shell metachars (we don't use a shell, but stay defensive) and
// dangerous git options that could read/write outside the repo or
// trigger arbitrary code execution via upload-pack/receive-pack.
const FORBIDDEN_ARG_PATTERNS = [
  /^--upload-pack[=]/i,
  /^--receive-pack[=]/i,
  /^--exec[=]/i
];

// Whitelist of allowed first-position git subcommands.
const ALLOWED_SUBCOMMANDS = new Set([
  'status', 'rev-parse', 'diff', 'pull', 'push', 'add', 'commit', 'rev-list',
  'log', 'show', 'worktree'
]);

// Log/show field + record separators. ASCII Unit Separator (0x1f) between
// fields — git output never contains it in normal use, and the existing
// validateArgs NUL check blocks 0x00 from being passed through. ASCII
// Record Separator (0x1e) between records since subject/body can contain
// newlines.
const LOG_FIELD_SEP = '\x1f';
const LOG_RECORD_SEP = '\x1e';
const LOG_FMT =
  `%H${LOG_FIELD_SEP}%P${LOG_FIELD_SEP}%an${LOG_FIELD_SEP}%aI${LOG_FIELD_SEP}%s${LOG_FIELD_SEP}%b${LOG_RECORD_SEP}`;
// Batched format used when callers pass includeFiles=true. We drop the body
// field because git interleaves --name-status output immediately after the
// pretty-format with no separator, and body can contain arbitrary newlines —
// making body + file-list unambiguous to parse requires losing one of them.
// Bodies aren't rendered in the timeline UI, only subjects, so this is the
// cheaper tradeoff. We also put the record separator at the START of each
// record instead of the end, so the file list of commit N is unambiguously
// part of record N (not a prefix of record N+1).
const LOG_FMT_WITH_FILES =
  `${LOG_RECORD_SEP}%H${LOG_FIELD_SEP}%P${LOG_FIELD_SEP}%an${LOG_FIELD_SEP}%aI${LOG_FIELD_SEP}%s`;

// Commit hash shape: hex 7-64 chars. git short hashes are usually 7-12; full
// SHA-1 is 40, SHA-256 will be 64. Allow callers to pass either.
const COMMIT_HASH_RE = /^[0-9a-fA-F]{7,64}$/;

function serviceError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

function defaultExec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      windowsHide: true,
      killSignal: 'SIGKILL',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          stdout: stdout?.toString?.() ?? String(stdout ?? ''),
          stderr: stderr?.toString?.() ?? String(stderr ?? error.message),
          code: typeof error.code === 'number' ? error.code : 1
        });
        return;
      }
      resolve({
        stdout: stdout?.toString?.() ?? String(stdout ?? ''),
        stderr: stderr?.toString?.() ?? String(stderr ?? ''),
        code: 0
      });
    });
    // Guard: if the child fails to spawn, child may be undefined.
    void child;
  });
}

function validateArgs(args) {
  if (!Array.isArray(args)) throw serviceError(500, 'git args must be an array');
  if (args.length === 0) throw serviceError(500, 'git args must not be empty');
  const sub = args[0];
  if (!ALLOWED_SUBCOMMANDS.has(sub)) {
    throw serviceError(400, `git subcommand not allowed: ${sub}`);
  }
  for (const a of args) {
    if (typeof a !== 'string') throw serviceError(500, 'git arg must be a string');
    if (a.includes('\0')) throw serviceError(400, 'git arg contains NUL');
    for (const pat of FORBIDDEN_ARG_PATTERNS) {
      if (pat.test(a)) throw serviceError(400, `git arg not allowed: ${a}`);
    }
  }
}

function sanitizeMessage(raw) {
  if (raw === undefined || raw === null) return '';
  let s = String(raw);
  // Strip control chars except \n and \t
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  s = s.trim();
  if (s.length > MAX_MESSAGE_LENGTH) s = s.slice(0, MAX_MESSAGE_LENGTH);
  return s;
}

// Parse `git worktree list --porcelain` output. Records are separated by a
// blank line; each starts with a `worktree <path>` line followed by optional
// `HEAD <sha>`, `branch refs/heads/<name>` (stripped to <name>), `detached`,
// `bare`, `locked [<reason>]`, `prunable [<reason>]`. The first record is the
// main worktree. Lines we don't recognise are ignored.
function parseWorktreePorcelain(stdout) {
  if (!stdout || typeof stdout !== 'string') return [];
  const out = [];
  let current = null;
  const flush = () => {
    if (current && current.path) out.push(current);
    current = null;
  };
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) {
      flush();
      continue;
    }
    const sep = line.indexOf(' ');
    const key = sep === -1 ? line : line.slice(0, sep);
    const value = sep === -1 ? '' : line.slice(sep + 1).trim();
    if (key === 'worktree') {
      flush();
      current = { path: value, branch: null, head: null, bare: false, detached: false, locked: false };
      continue;
    }
    if (!current) continue;
    if (key === 'HEAD') current.head = value || null;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '') || null;
    else if (key === 'detached') current.detached = true;
    else if (key === 'bare') current.bare = true;
    else if (key === 'locked') current.locked = true;
  }
  flush();
  return out;
}

function truncateDiff(text) {
  if (typeof text !== 'string') text = String(text ?? '');
  // Use byte length via Buffer to be accurate.
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= DIFF_TRUNCATE_BYTES) return text;
  const head = buf.slice(0, DIFF_TRUNCATE_BYTES).toString('utf8');
  return head + TRUNCATE_MARKER;
}

export function createGitService({ exec = defaultExec, now = () => new Date() } = {}) {
  if (typeof exec !== 'function') throw new Error('createGitService: exec must be a function');

  async function runGit(repoPath, args, opts = {}) {
    validateArgs(args);
    const result = await exec('git', args, {
      cwd: repoPath,
      timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER
    });
    return result || { stdout: '', stderr: '', code: 1 };
  }

  async function assertRepo(repoPath) {
    if (!repoPath || typeof repoPath !== 'string') {
      throw serviceError(400, 'repoPath is required');
    }
    if (!path.isAbsolute(repoPath)) {
      throw serviceError(400, 'repoPath must be absolute');
    }
    let stat;
    try {
      stat = await fs.stat(repoPath);
    } catch {
      throw serviceError(400, `repoPath does not exist: ${repoPath}`);
    }
    if (!stat.isDirectory()) {
      throw serviceError(400, `repoPath is not a directory: ${repoPath}`);
    }
    // Confirm it's a git repo via rev-parse --git-dir
    const result = await runGit(repoPath, ['rev-parse', '--git-dir']);
    if (result.code !== 0) {
      throw serviceError(400, `not a git repository: ${repoPath}`);
    }
  }

  function gitFailure(action, result) {
    const msg = (result.stderr || result.stdout || '').trim() || `${action} failed`;
    const err = new Error(msg);
    err.statusCode = 502;
    err.stdout = result.stdout || '';
    err.stderr = result.stderr || '';
    err.code = result.code;
    return err;
  }

  function parseStatusPorcelainV2(stdout) {
    const branch = { name: null, ahead: 0, behind: 0 };
    const untracked = [];
    const modified = [];
    const staged = [];
    if (!stdout) return { branch, untracked, modified, staged };
    // Split on NUL since we asked for -z
    const records = stdout.split('\0');
    for (let i = 0; i < records.length; i += 1) {
      const rec = records[i];
      if (!rec) continue;
      if (rec.startsWith('# branch.head ')) {
        branch.name = rec.slice('# branch.head '.length).trim();
        if (branch.name === '(detached)') branch.name = null;
        continue;
      }
      if (rec.startsWith('# branch.ab ')) {
        const m = rec.match(/\+(\d+)\s+-(\d+)/);
        if (m) {
          branch.ahead = Number(m[1]) || 0;
          branch.behind = Number(m[2]) || 0;
        }
        continue;
      }
      if (rec.startsWith('#')) continue;
      // Ordinary changed: "1 XY sub mH mI mW hH hI path"
      if (rec.startsWith('1 ')) {
        const parts = rec.split(' ');
        const xy = parts[1] || '..';
        const filePath = parts.slice(8).join(' ');
        const stagedChar = xy[0];
        const worktreeChar = xy[1];
        if (stagedChar && stagedChar !== '.') staged.push(filePath);
        if (worktreeChar && worktreeChar !== '.') modified.push(filePath);
        continue;
      }
      // Renamed/copied: "2 XY sub mH mI mW hH hI X<score> path\torigPath"
      // With -z, the next NUL record is origPath; we skip orig.
      if (rec.startsWith('2 ')) {
        const parts = rec.split(' ');
        const xy = parts[1] || '..';
        const filePath = parts.slice(9).join(' ');
        const stagedChar = xy[0];
        const worktreeChar = xy[1];
        if (stagedChar && stagedChar !== '.') staged.push(filePath);
        if (worktreeChar && worktreeChar !== '.') modified.push(filePath);
        // Consume origPath record
        i += 1;
        continue;
      }
      // Untracked: "? path"
      if (rec.startsWith('? ')) {
        untracked.push(rec.slice(2));
        continue;
      }
      // Unmerged: "u XY ..."
      if (rec.startsWith('u ')) {
        const parts = rec.split(' ');
        const filePath = parts.slice(10).join(' ');
        modified.push(filePath);
        continue;
      }
    }
    return { branch, untracked, modified, staged };
  }

  async function status(repoPath) {
    await assertRepo(repoPath);
    const result = await runGit(repoPath, ['status', '--porcelain=v2', '--branch', '-z']);
    if (result.code !== 0) throw gitFailure('git status', result);
    const parsed = parseStatusPorcelainV2(result.stdout);
    const dirty = parsed.modified.length > 0 || parsed.staged.length > 0 || parsed.untracked.length > 0;
    return {
      branch: parsed.branch.name,
      ahead: parsed.branch.ahead,
      behind: parsed.branch.behind,
      dirty,
      untracked: parsed.untracked,
      modified: parsed.modified,
      staged: parsed.staged
    };
  }

  async function diff(repoPath, { file, staged, commit } = {}) {
    await assertRepo(repoPath);
    // commit-mode uses `git show <hash>` instead of `git diff`; show emits the
    // same unified-diff body the client already renders, plus the commit
    // metadata header (which we strip later if needed).
    if (commit) {
      if (typeof commit !== 'string' || !COMMIT_HASH_RE.test(commit)) {
        throw serviceError(400, 'commit must be a valid hex hash');
      }
      if (staged) throw serviceError(400, 'staged is incompatible with commit');
      const args = ['show', '--no-color', '--format=', commit];
      if (file) {
        if (typeof file !== 'string') throw serviceError(400, 'file must be a string');
        if (file.startsWith('-')) throw serviceError(400, 'file must not start with -');
        if (file.includes('\0')) throw serviceError(400, 'file contains NUL');
        args.push('--', file);
      }
      const result = await runGit(repoPath, args);
      if (result.code !== 0 && !result.stdout) throw gitFailure('git show', result);
      return { diff: truncateDiff(result.stdout || '') };
    }
    const args = ['diff'];
    if (staged) args.push('--cached');
    args.push('--no-color');
    if (file) {
      if (typeof file !== 'string') throw serviceError(400, 'file must be a string');
      if (file.startsWith('-')) throw serviceError(400, 'file must not start with -');
      if (file.includes('\0')) throw serviceError(400, 'file contains NUL');
      args.push('--', file);
    }
    const result = await runGit(repoPath, args);
    if (result.code !== 0 && !result.stdout) throw gitFailure('git diff', result);
    return { diff: truncateDiff(result.stdout || '') };
  }

  function parseHistoryOutput(stdout) {
    if (!stdout) return [];
    const out = [];
    const records = stdout.split(LOG_RECORD_SEP);
    for (const raw of records) {
      const rec = raw.replace(/^\n+/, '');
      if (!rec) continue;
      const fields = rec.split(LOG_FIELD_SEP);
      if (fields.length < 6) continue;
      const [hash, parentsRaw, author, date, subject, body] = fields;
      if (!hash) continue;
      out.push({
        hash: hash.trim(),
        parents: parentsRaw ? parentsRaw.trim().split(/\s+/).filter(Boolean) : [],
        author: author || '',
        date: date || '',
        subject: subject || '',
        body: (body || '').replace(/\s+$/, '')
      });
    }
    return out;
  }

  function parseNameStatusLine(line) {
    const parts = line.split('\t');
    if (parts.length < 2) return null;
    const rawStatus = parts[0].trim();
    if (!rawStatus) return null;
    const head = rawStatus[0];
    if ((head === 'R' || head === 'C') && parts.length >= 3) {
      const from = parts[1];
      const to = parts[2];
      if (!from || !to) return null;
      return { status: head, path: to, from };
    }
    const path = parts.slice(1).join('\t');
    if (!path) return null;
    return { status: head, path };
  }

  function parseHistoryWithFilesOutput(stdout) {
    if (!stdout) return [];
    const out = [];
    const records = stdout.split(LOG_RECORD_SEP);
    for (const raw of records) {
      if (!raw) continue;
      // First line of the record holds the 5 header fields; subsequent lines
      // (until end of record) are name-status entries.
      const firstNewline = raw.indexOf('\n');
      const headerLine = firstNewline >= 0 ? raw.slice(0, firstNewline) : raw;
      const fileBlock = firstNewline >= 0 ? raw.slice(firstNewline + 1) : '';
      const fields = headerLine.split(LOG_FIELD_SEP);
      if (fields.length < 5) continue;
      const [hash, parentsRaw, author, date, subject] = fields;
      if (!hash) continue;
      const files = [];
      for (const ln of fileBlock.split('\n')) {
        const trimmed = ln.replace(/\r$/, '');
        if (!trimmed) continue;
        const entry = parseNameStatusLine(trimmed);
        if (entry) files.push(entry);
      }
      out.push({
        hash: hash.trim(),
        parents: parentsRaw ? parentsRaw.trim().split(/\s+/).filter(Boolean) : [],
        author: author || '',
        date: date || '',
        subject: subject || '',
        body: '', // dropped in includeFiles mode — see LOG_FMT_WITH_FILES comment
        files
      });
    }
    return out;
  }

  async function history(repoPath, { limit = 50, cursor = null, includeFiles = false } = {}) {
    await assertRepo(repoPath);
    const parsed = Number(limit);
    const safeLimit = Number.isFinite(parsed)
      ? Math.max(1, Math.min(500, Math.floor(parsed)))
      : 50;
    const fmt = includeFiles ? LOG_FMT_WITH_FILES : LOG_FMT;
    const args = ['log', `--pretty=format:${fmt}`, '-n', String(safeLimit + 1)];
    if (includeFiles) args.push('--name-status');
    if (cursor) {
      if (typeof cursor !== 'string' || !COMMIT_HASH_RE.test(cursor)) {
        throw serviceError(400, 'cursor must be a valid hex hash');
      }
      // git log <cursor> starts AT the cursor commit and walks back. Tests
      // typically want the commit AFTER the cursor; we include cursor itself
      // so callers can disambiguate (it'll dedupe on client side).
      args.push(cursor);
    }
    const result = await runGit(repoPath, args);
    if (result.code !== 0 && !result.stdout) throw gitFailure('git log', result);
    const all = includeFiles
      ? parseHistoryWithFilesOutput(result.stdout)
      : parseHistoryOutput(result.stdout);
    const hasMore = all.length > safeLimit;
    const commits = hasMore ? all.slice(0, safeLimit) : all;
    const nextCursor = hasMore ? all[safeLimit].hash : null;
    return { commits, nextCursor };
  }

  async function commitFiles(repoPath, hash) {
    await assertRepo(repoPath);
    if (typeof hash !== 'string' || !COMMIT_HASH_RE.test(hash)) {
      throw serviceError(400, 'hash must be a valid hex hash');
    }
    // --name-status format:
    //   regular: "M\tpath"
    //   rename : "R<score>\told\tnew"    (e.g. "R100\tsrc/a.js\tsrc/b.js")
    //   copy   : "C<score>\tsrc\tdst"
    // We let git report renames/copies so the UI can show "old → new"
    // instead of an A+D pair that loses the relationship.
    const result = await runGit(repoPath, ['show', '--name-status', '--format=', hash]);
    if (result.code !== 0 && !result.stdout) throw gitFailure('git show', result);
    const files = [];
    for (const line of (result.stdout || '').split('\n')) {
      const trimmed = line.replace(/\r$/, '');
      if (!trimmed) continue;
      const parts = trimmed.split('\t');
      if (parts.length < 2) continue;
      const rawStatus = parts[0].trim();
      if (!rawStatus) continue;
      const head = rawStatus[0];
      if ((head === 'R' || head === 'C') && parts.length >= 3) {
        const from = parts[1];
        const to = parts[2];
        if (!from || !to) continue;
        files.push({ status: head, path: to, from });
      } else {
        const path = parts.slice(1).join('\t');
        if (!path) continue;
        files.push({ status: head, path });
      }
    }
    return { hash, files };
  }

  async function worktrees(repoPath) {
    await assertRepo(repoPath);
    const result = await runGit(repoPath, ['worktree', 'list', '--porcelain']);
    if (result.code !== 0 && !result.stdout) throw gitFailure('git worktree list', result);
    return { worktrees: parseWorktreePorcelain(result.stdout) };
  }

  async function pull(repoPath) {
    await assertRepo(repoPath);
    const result = await runGit(repoPath, ['pull', '--ff-only']);
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      success: result.code === 0
    };
  }

  function validateCommitPaths(paths) {
    if (!Array.isArray(paths)) throw serviceError(400, 'paths must be an array');
    const out = [];
    for (const raw of paths) {
      if (typeof raw !== 'string') throw serviceError(400, 'each path must be a string');
      const p = raw.trim();
      if (!p) continue;
      if (p.includes('\0')) throw serviceError(400, 'path contains NUL');
      // Block path-traversal (../ and ..\) anywhere in the path
      if (/(^|[/\\])\.\.([/\\]|$)/.test(p)) throw serviceError(400, `path traversal not allowed: ${raw}`);
      // Absolute paths are out of scope — only repo-relative
      if (/^([a-zA-Z]:)?[\\/]/.test(p)) throw serviceError(400, `absolute path not allowed: ${raw}`);
      out.push(p);
    }
    return out;
  }

  async function commitPush(repoPath, { message, addAll = true, paths } = {}) {
    await assertRepo(repoPath);
    const cleanMsg = sanitizeMessage(message);
    if (!cleanMsg) throw serviceError(400, 'commit message is required');

    // Validate paths up-front so we fail before touching the repo
    const selectedPaths = paths !== undefined ? validateCommitPaths(paths) : null;

    // Check if there is anything to commit
    const dirtyCheck = await runGit(repoPath, ['status', '--porcelain']);
    if (dirtyCheck.code !== 0) throw gitFailure('git status', dirtyCheck);
    if (!dirtyCheck.stdout || !dirtyCheck.stdout.trim()) {
      throw serviceError(400, 'nothing to commit');
    }

    const out = { committed: false, pushed: false, sha: undefined, stdout: '', stderr: '' };

    if (selectedPaths && selectedPaths.length > 0) {
      // Selective staging — `--` separator prevents leading-dash flag injection
      const addRes = await runGit(repoPath, ['add', '--', ...selectedPaths]);
      out.stdout += addRes.stdout || '';
      out.stderr += addRes.stderr || '';
      if (addRes.code !== 0) throw gitFailure('git add', addRes);
    } else if (addAll) {
      const addRes = await runGit(repoPath, ['add', '-A']);
      out.stdout += addRes.stdout || '';
      out.stderr += addRes.stderr || '';
      if (addRes.code !== 0) throw gitFailure('git add', addRes);
    }

    const commitRes = await runGit(repoPath, ['commit', '-m', cleanMsg]);
    out.stdout += commitRes.stdout || '';
    out.stderr += commitRes.stderr || '';
    if (commitRes.code !== 0) throw gitFailure('git commit', commitRes);
    out.committed = true;

    // Capture SHA
    const shaRes = await runGit(repoPath, ['rev-parse', 'HEAD']);
    if (shaRes.code === 0) {
      out.sha = (shaRes.stdout || '').trim() || undefined;
    }

    const pushRes = await runGit(repoPath, ['push']);
    out.stdout += pushRes.stdout || '';
    out.stderr += pushRes.stderr || '';
    if (pushRes.code !== 0) {
      // Don't throw — caller asked us not to roll back; just report.
      return out;
    }
    out.pushed = true;
    return out;
  }

  return {
    status,
    diff,
    pull,
    commitPush,
    history,
    commitFiles,
    worktrees,
    // exposed for tests
    _internals: { sanitizeMessage, truncateDiff, parseStatusPorcelainV2, parseHistoryOutput, parseHistoryWithFilesOutput, parseWorktreePorcelain, validateArgs, TRUNCATE_MARKER }
  };
}

export const __test__ = {
  sanitizeMessage,
  truncateDiff,
  parseWorktreePorcelain,
  TRUNCATE_MARKER,
  DIFF_TRUNCATE_BYTES
};
