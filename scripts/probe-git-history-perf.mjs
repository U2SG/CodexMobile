// Measure server-side response time for /api/git/history with realistic page
// sizes against this very repo. Useful as a lower bound on what the client
// is going to render — if 100 commits + per-commit files takes >1s server-
// side, no amount of client virtualization will hide it. If it's <100ms,
// scroll perf is purely a render-side question.
//
// Local-only: runs gitService directly (no HTTP / no auth). Counts each
// commit's commitFiles fetch separately so we can see whether the timeline-
// expand UX would jank if a user opens every commit on the page.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { createGitService } from '../server/git-service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_PATH = path.resolve(HERE, '..');

const svc = createGitService({});

async function timed(label, fn) {
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  return { label, ms, result };
}

async function run() {
  console.log(`repo: ${REPO_PATH}`);
  console.log('');

  console.log('history page latency (metadata only):');
  for (const limit of [25, 50, 100, 200]) {
    const { ms, result } = await timed(`history limit=${limit}`, () => svc.history(REPO_PATH, { limit }));
    console.log(
      `  limit=${String(limit).padStart(3)}  commits=${String(result.commits.length).padStart(3)}  ${ms.toFixed(1).padStart(7)}ms`
    );
  }

  console.log('');
  console.log('history + per-commit files (the path the client actually takes):');
  console.log('');

  // Path A — pre-batched-endpoint behavior: one history call + N commit-files calls.
  const pageA = await svc.history(REPO_PATH, { limit: 100 });
  const samplesA = pageA.commits.slice(0, 100);
  const tSeqStart = performance.now();
  let totalFilesA = 0;
  for (const c of samplesA) {
    const cf = await svc.commitFiles(REPO_PATH, c.hash);
    totalFilesA += cf.files.length;
  }
  const seqMs = performance.now() - tSeqStart;
  console.log(
    `  legacy (1 + N): ${samplesA.length} commits, ${totalFilesA} files in ${seqMs.toFixed(0)}ms ` +
    `(${(seqMs / Math.max(1, samplesA.length)).toFixed(1)}ms/commit on expand)`
  );

  // Path B — new batched endpoint: one history call with --name-status.
  const tBatchStart = performance.now();
  const pageB = await svc.history(REPO_PATH, { limit: 100, includeFiles: true });
  const batchMs = performance.now() - tBatchStart;
  const totalFilesB = pageB.commits.reduce((acc, c) => acc + (c.files?.length || 0), 0);
  console.log(
    `  batched (1):    ${pageB.commits.length} commits, ${totalFilesB} files in ${batchMs.toFixed(0)}ms`
  );

  if (seqMs > 0) {
    const factor = (seqMs / Math.max(1, batchMs)).toFixed(1);
    console.log('');
    console.log(`  → batched is ${factor}× faster for the "show 100 commits + every file list" path`);
  }
}

run().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
