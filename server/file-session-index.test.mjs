import { strict as assert } from 'node:assert';
import path from 'node:path';
import { test } from 'node:test';

import {
  createFileSessionIndex,
  parseCodexRolloutForFileTouches,
  parseClaudeRolloutForFileTouches,
  parseRolloutForFileTouches
} from './file-session-index.js';

function rolloutJsonl(lines) {
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

function metaLine({ id, cwd, timestamp = '2026-05-17T10:00:00Z' }) {
  return {
    timestamp,
    type: 'session_meta',
    payload: { id, cwd, timestamp }
  };
}

function applyPatchLine({ timestamp, patch }) {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      status: 'completed',
      name: 'apply_patch',
      input: patch
    }
  };
}

const SAMPLE_PATCH = [
  '*** Begin Patch',
  '*** Add File: src/new.js',
  '+const hello = 1;',
  '*** Update File: src/existing.js',
  '@@',
  '-old',
  '+new',
  '*** Delete File: legacy/gone.js',
  '*** End Patch'
].join('\n');

test('parseRolloutForFileTouches extracts session id, cwd, and patch ops', () => {
  const jsonl = rolloutJsonl([
    metaLine({ id: 'sess-1', cwd: 'C:/repo' }),
    applyPatchLine({ timestamp: '2026-05-17T10:05:00Z', patch: SAMPLE_PATCH })
  ]);
  const parsed = parseRolloutForFileTouches(jsonl);
  assert.equal(parsed.sessionId, 'sess-1');
  assert.equal(parsed.cwd, 'C:/repo');
  assert.equal(parsed.touches.length, 3);
  assert.deepEqual(parsed.touches.map((t) => t.op).sort(), ['add', 'delete', 'update']);
  assert.deepEqual(parsed.touches.map((t) => t.relPath).sort(), [
    'legacy/gone.js',
    'src/existing.js',
    'src/new.js'
  ]);
});

test('parseRolloutForFileTouches skips unknown response_item types', () => {
  const jsonl = rolloutJsonl([
    metaLine({ id: 'sess-2', cwd: '/tmp/repo' }),
    {
      timestamp: '2026-05-17T10:01:00Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell_command', arguments: '{}' }
    },
    {
      timestamp: '2026-05-17T10:02:00Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }
    },
    applyPatchLine({ timestamp: '2026-05-17T10:03:00Z', patch: '*** Begin Patch\n*** Add File: a.txt\n*** End Patch' })
  ]);
  const parsed = parseRolloutForFileTouches(jsonl);
  assert.equal(parsed.touches.length, 1);
  assert.equal(parsed.touches[0].relPath, 'a.txt');
});

test('parseRolloutForFileTouches tolerates broken JSON lines', () => {
  const jsonl = [
    JSON.stringify(metaLine({ id: 's', cwd: '/r' })),
    'not json',
    '',
    JSON.stringify(applyPatchLine({ timestamp: '2026-05-17T11:00:00Z', patch: '*** Add File: x.txt' }))
  ].join('\n');
  const parsed = parseRolloutForFileTouches(jsonl);
  assert.equal(parsed.sessionId, 's');
  assert.equal(parsed.touches.length, 1);
});

test('parseRolloutForFileTouches ignores non-apply_patch custom_tool_call', () => {
  const jsonl = rolloutJsonl([
    metaLine({ id: 's3', cwd: '/r' }),
    {
      timestamp: '2026-05-17T10:00:00Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'web_search', input: 'react hooks' }
    }
  ]);
  const parsed = parseRolloutForFileTouches(jsonl);
  assert.equal(parsed.touches.length, 0);
});

// ---- index integration ----

test('records carry agent classification when classifySourceFile is injected', async () => {
  const rollouts = {
    '/codex/a.jsonl': rolloutJsonl([
      metaLine({ id: 'codex-s', cwd: '/r' }),
      applyPatchLine({ timestamp: '2026-05-16T10:00:00Z', patch: '*** Add File: a.txt' })
    ]),
    '/claude/b.jsonl': rolloutJsonl([
      metaLine({ id: 'claude-s', cwd: '/r' }),
      applyPatchLine({ timestamp: '2026-05-16T11:00:00Z', patch: '*** Update File: a.txt' })
    ])
  };
  const index = createFileSessionIndex({
    listRolloutFiles: async () => Object.keys(rollouts).map((p) => ({ path: p, mtimeMs: 1 })),
    readRolloutFile: async (name) => rollouts[name],
    classifySourceFile: (filePath) => filePath.includes('codex') ? 'codex' : 'claude'
  });
  const hits = await index.getSessionsForFile('/r/a.txt');
  const byId = Object.fromEntries(hits.map((h) => [h.sessionId, h]));
  assert.equal(byId['codex-s'].agent, 'codex');
  assert.equal(byId['claude-s'].agent, 'claude');
});

test('records have agent=undefined when no classifier injected', async () => {
  const rollouts = {
    'a.jsonl': rolloutJsonl([
      metaLine({ id: 's', cwd: '/r' }),
      applyPatchLine({ timestamp: '2026-05-16T10:00:00Z', patch: '*** Add File: a.txt' })
    ])
  };
  const index = createFileSessionIndex({
    listRolloutFiles: async () => Object.keys(rollouts).map((p) => ({ path: p, mtimeMs: 1 })),
    readRolloutFile: async (name) => rollouts[name]
  });
  const hits = await index.getSessionsForFile('/r/a.txt');
  assert.equal(hits[0].agent, undefined);
});

test('createFileSessionIndex requires injected listRolloutFiles + readRolloutFile', () => {
  assert.throws(() => createFileSessionIndex({}), /listRolloutFiles is required/);
  assert.throws(() => createFileSessionIndex({ listRolloutFiles: () => [] }), /readRolloutFile is required/);
});

test('getSessionsForFile returns sessions sorted by recency, de-duped', async () => {
  const rollouts = {
    'a.jsonl': rolloutJsonl([
      metaLine({ id: 'old-session', cwd: 'C:/repo' }),
      applyPatchLine({ timestamp: '2026-05-10T00:00:00Z', patch: '*** Add File: src/foo.js' })
    ]),
    'b.jsonl': rolloutJsonl([
      metaLine({ id: 'recent-session', cwd: 'C:/repo' }),
      applyPatchLine({ timestamp: '2026-05-16T00:00:00Z', patch: '*** Update File: src/foo.js' }),
      applyPatchLine({ timestamp: '2026-05-16T00:05:00Z', patch: '*** Update File: src/foo.js' })
    ]),
    'c.jsonl': rolloutJsonl([
      metaLine({ id: 'other-file-session', cwd: 'C:/repo' }),
      applyPatchLine({ timestamp: '2026-05-15T00:00:00Z', patch: '*** Add File: docs/readme.md' })
    ])
  };
  const index = createFileSessionIndex({
    listRolloutFiles: async () => Object.keys(rollouts),
    readRolloutFile: async (name) => rollouts[name]
  });
  const hits = await index.getSessionsForFile(path.resolve('C:/repo', 'src/foo.js'));
  // recent-session counted ONCE despite two touches; sorted ahead of old-session
  assert.deepEqual(hits.map((h) => h.sessionId), ['recent-session', 'old-session']);
});

test('getSessionsForFile resolves relative apply_patch paths against session cwd', async () => {
  const rollouts = {
    'a.jsonl': rolloutJsonl([
      metaLine({ id: 's1', cwd: 'C:/repo-one' }),
      applyPatchLine({ timestamp: '2026-05-16T00:00:00Z', patch: '*** Update File: src/foo.js' })
    ]),
    'b.jsonl': rolloutJsonl([
      metaLine({ id: 's2', cwd: 'C:/repo-two' }),
      applyPatchLine({ timestamp: '2026-05-16T00:00:00Z', patch: '*** Update File: src/foo.js' })
    ])
  };
  const index = createFileSessionIndex({
    listRolloutFiles: async () => Object.keys(rollouts),
    readRolloutFile: async (name) => rollouts[name]
  });
  const inOne = await index.getSessionsForFile(path.resolve('C:/repo-one', 'src/foo.js'));
  const inTwo = await index.getSessionsForFile(path.resolve('C:/repo-two', 'src/foo.js'));
  assert.deepEqual(inOne.map((h) => h.sessionId), ['s1']);
  assert.deepEqual(inTwo.map((h) => h.sessionId), ['s2']);
});

test('getSessionsForFile returns [] for unknown paths', async () => {
  const index = createFileSessionIndex({
    listRolloutFiles: async () => [],
    readRolloutFile: async () => ''
  });
  assert.deepEqual(await index.getSessionsForFile('/never/touched.js'), []);
});

test('build caches; invalidate forces a re-scan', async () => {
  let listCalls = 0;
  const index = createFileSessionIndex({
    listRolloutFiles: async () => {
      listCalls += 1;
      return [];
    },
    readRolloutFile: async () => ''
  });
  await index.getSessionsForFile('/x');
  await index.getSessionsForFile('/y');
  assert.equal(listCalls, 1, 'second query should hit cache');
  index.invalidate();
  await index.getSessionsForFile('/x');
  assert.equal(listCalls, 2, 'invalidate forces a rebuild');
});

test('inflight build is shared across concurrent callers', async () => {
  let listCalls = 0;
  let resolveList;
  const listPromise = new Promise((resolve) => {
    resolveList = resolve;
  });
  const index = createFileSessionIndex({
    listRolloutFiles: async () => {
      listCalls += 1;
      await listPromise;
      return [];
    },
    readRolloutFile: async () => ''
  });
  const a = index.getSessionsForFile('/x');
  const b = index.getSessionsForFile('/y');
  // Don't await yet — both should be sharing one in-flight build.
  resolveList();
  await Promise.all([a, b]);
  assert.equal(listCalls, 1);
});

test('getSessionsForFile respects limit option', async () => {
  const rollouts = Array.from({ length: 8 }).map((_, i) => [
    `r${i}.jsonl`,
    rolloutJsonl([
      metaLine({ id: `s${i}`, cwd: '/repo' }),
      applyPatchLine({ timestamp: `2026-05-${10 + i}T00:00:00Z`, patch: '*** Update File: src/x.js' })
    ])
  ]);
  const map = Object.fromEntries(rollouts);
  const index = createFileSessionIndex({
    listRolloutFiles: async () => Object.keys(map),
    readRolloutFile: async (name) => map[name]
  });
  const hits = await index.getSessionsForFile(path.resolve('/repo', 'src/x.js'), { limit: 3 });
  assert.equal(hits.length, 3);
  // The three most recent sessions are s7, s6, s5
  assert.deepEqual(hits.map((h) => h.sessionId), ['s7', 's6', 's5']);
});

test('readRolloutFile errors are skipped without breaking the build', async () => {
  const rollouts = {
    'ok.jsonl': rolloutJsonl([
      metaLine({ id: 'ok', cwd: '/r' }),
      applyPatchLine({ timestamp: '2026-05-16T00:00:00Z', patch: '*** Add File: a.txt' })
    ]),
    'bad.jsonl': null
  };
  const index = createFileSessionIndex({
    listRolloutFiles: async () => Object.keys(rollouts),
    readRolloutFile: async (name) => {
      if (rollouts[name] === null) throw new Error('disk failure');
      return rollouts[name];
    }
  });
  const hits = await index.getSessionsForFile(path.resolve('/r', 'a.txt'));
  assert.deepEqual(hits.map((h) => h.sessionId), ['ok']);
});

test('Windows absolute paths normalize to the same key (D:\\ vs d:\\)', async () => {
  if (process.platform !== 'win32') return; // case-insensitive normalization is win32-only
  const rollouts = {
    'a.jsonl': rolloutJsonl([
      metaLine({ id: 'win', cwd: 'D:\\Project' }),
      applyPatchLine({ timestamp: '2026-05-16T00:00:00Z', patch: '*** Update File: src\\foo.js' })
    ])
  };
  const index = createFileSessionIndex({
    listRolloutFiles: async () => Object.keys(rollouts),
    readRolloutFile: async (name) => rollouts[name]
  });
  const hitsLower = await index.getSessionsForFile('d:\\project\\src\\foo.js');
  const hitsUpper = await index.getSessionsForFile('D:\\Project\\src\\foo.js');
  assert.equal(hitsLower.length, 1);
  assert.equal(hitsUpper.length, 1);
  assert.equal(hitsLower[0].sessionId, hitsUpper[0].sessionId);
});

// ---- claude rollout parser ----

function claudeAssistantLine({ sessionId, cwd, timestamp, name, input }) {
  return {
    type: 'assistant',
    sessionId,
    cwd,
    timestamp,
    message: {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: `toolu_${name}`, name, input }
      ]
    }
  };
}

function claudeJsonl(lines) {
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

test('parseClaudeRolloutForFileTouches extracts Write/Edit/MultiEdit/NotebookEdit touches', () => {
  const sample = claudeJsonl([
    { type: 'permission-mode', sessionId: 'sess-c1' },
    claudeAssistantLine({
      sessionId: 'sess-c1',
      cwd: 'D:\\project\\stats',
      timestamp: '2026-05-13T10:00:00Z',
      name: 'Write',
      input: { file_path: 'D:\\project\\stats\\CLAUDE.md', content: '...' }
    }),
    claudeAssistantLine({
      sessionId: 'sess-c1',
      cwd: 'D:\\project\\stats',
      timestamp: '2026-05-13T10:05:00Z',
      name: 'Edit',
      input: { file_path: 'D:\\project\\stats\\src\\foo.py' }
    }),
    claudeAssistantLine({
      sessionId: 'sess-c1',
      cwd: 'D:\\project\\stats',
      timestamp: '2026-05-13T10:06:00Z',
      name: 'NotebookEdit',
      input: { notebook_path: 'D:\\project\\stats\\nb.ipynb' }
    })
  ]);
  const parsed = parseClaudeRolloutForFileTouches(sample);
  assert.equal(parsed.sessionId, 'sess-c1');
  assert.equal(parsed.cwd, 'D:\\project\\stats');
  assert.equal(parsed.touches.length, 3);
  assert.deepEqual(parsed.touches.map((t) => t.relPath), [
    'D:\\project\\stats\\CLAUDE.md',
    'D:\\project\\stats\\src\\foo.py',
    'D:\\project\\stats\\nb.ipynb'
  ]);
  assert.deepEqual(parsed.touches.map((t) => t.op), ['add', 'update', 'update']);
});

test('parseClaudeRolloutForFileTouches ignores Read/Bash/Glob and other read-only tools', () => {
  const sample = claudeJsonl([
    claudeAssistantLine({
      sessionId: 's', cwd: '/r', timestamp: '2026-05-13T10:00:00Z',
      name: 'Read', input: { file_path: '/r/anything.txt' }
    }),
    claudeAssistantLine({
      sessionId: 's', cwd: '/r', timestamp: '2026-05-13T10:01:00Z',
      name: 'Bash', input: { command: 'cat /r/foo' }
    }),
    claudeAssistantLine({
      sessionId: 's', cwd: '/r', timestamp: '2026-05-13T10:02:00Z',
      name: 'Glob', input: { pattern: '**/*.py' }
    })
  ]);
  const parsed = parseClaudeRolloutForFileTouches(sample);
  assert.equal(parsed.touches.length, 0);
});

test('parseClaudeRolloutForFileTouches skips entries without sessionId/cwd', () => {
  const sample = claudeJsonl([
    {
      type: 'assistant',
      // no sessionId, no cwd, no timestamp
      message: {
        content: [
          { type: 'tool_use', name: 'Write', input: { file_path: '/x' } }
        ]
      }
    }
  ]);
  const parsed = parseClaudeRolloutForFileTouches(sample);
  // Without sessionId the whole record gets dropped at the index level;
  // parser still returns touches it found but the caller's null-out
  // logic handles the missing sessionId case.
  assert.equal(parsed.sessionId, null);
  assert.equal(parsed.touches.length, 1);
});

test('parseRolloutForFileTouches dispatches to codex parser for codex rollouts', () => {
  const codexSample = rolloutJsonl([
    metaLine({ id: 'codex-s', cwd: '/r' }),
    applyPatchLine({ timestamp: '2026-05-17T10:00:00Z', patch: '*** Add File: a.txt' })
  ]);
  const parsed = parseRolloutForFileTouches(codexSample);
  assert.equal(parsed.sessionId, 'codex-s');
  assert.equal(parsed.touches[0].relPath, 'a.txt');
});

test('parseRolloutForFileTouches dispatches to claude parser for claude rollouts', () => {
  const claudeSample = claudeJsonl([
    { type: 'permission-mode', sessionId: 'claude-s' },
    claudeAssistantLine({
      sessionId: 'claude-s', cwd: '/r', timestamp: '2026-05-13T10:00:00Z',
      name: 'Edit', input: { file_path: '/r/a.txt' }
    })
  ]);
  const parsed = parseRolloutForFileTouches(claudeSample);
  assert.equal(parsed.sessionId, 'claude-s');
  assert.equal(parsed.touches[0].relPath, '/r/a.txt');
});

test('claude windows-style paths produce a stable key regardless of process OS', async () => {
  // The index uses path.win32 when it sniffs a drive-letter prefix, so a
  // POSIX-host indexing claude rollouts (Windows-style cwd + file_path
  // strings) ends up with the same lookup key as a Windows host. We can't
  // change process.platform inside one test run, but we can assert that
  // index queries match the Windows-style path regardless of slashes/case.
  const rollouts = {
    'a.jsonl': claudeJsonl([
      { type: 'permission-mode', sessionId: 'win-sess' },
      claudeAssistantLine({
        sessionId: 'win-sess',
        cwd: 'D:\\Project\\stats',
        timestamp: '2026-05-13T10:00:00Z',
        name: 'Edit',
        input: { file_path: 'D:\\Project\\stats\\src\\Foo.py' }
      })
    ])
  };
  const index = createFileSessionIndex({
    listRolloutFiles: async () => [{ path: 'a.jsonl', mtimeMs: 1 }],
    readRolloutFile: async (name) => rollouts[name]
  });
  // Same path written four different ways must all hit the same key.
  const variants = [
    'D:\\Project\\stats\\src\\Foo.py',
    'd:\\project\\stats\\src\\foo.py',
    'D:/Project/stats/src/Foo.py',
    'd:/project/stats/src/foo.py'
  ];
  for (const variant of variants) {
    const hits = await index.getSessionsForFile(variant);
    assert.equal(hits.length, 1, `expected hit for variant ${variant}`);
    assert.equal(hits[0].sessionId, 'win-sess');
  }
});

test('file-session-index handles a mix of codex + claude rollouts in one index', async () => {
  const rollouts = {
    'codex/a.jsonl': rolloutJsonl([
      metaLine({ id: 'codex-sess', cwd: 'D:/repo' }),
      applyPatchLine({ timestamp: '2026-05-16T00:00:00Z', patch: '*** Update File: src/foo.js' })
    ]),
    'claude/b.jsonl': claudeJsonl([
      { type: 'permission-mode', sessionId: 'claude-sess' },
      claudeAssistantLine({
        sessionId: 'claude-sess',
        cwd: 'D:\\repo',
        timestamp: '2026-05-16T00:01:00Z',
        name: 'Edit',
        input: { file_path: 'D:\\repo\\src\\foo.js' }
      })
    ])
  };
  const index = createFileSessionIndex({
    listRolloutFiles: async () => Object.keys(rollouts).map((p) => ({ path: p, mtimeMs: 1 })),
    readRolloutFile: async (name) => rollouts[name]
  });
  const hits = await index.getSessionsForFile(path.resolve('D:/repo', 'src/foo.js'));
  // Both sessions appear; ordering by touchedAt — claude later, codex earlier.
  assert.equal(hits.length, 2);
  const ids = hits.map((h) => h.sessionId).sort();
  assert.deepEqual(ids, ['claude-sess', 'codex-sess']);
});

// ---- persistence + incremental ----

test('savePersistence is called after a successful build', async () => {
  let saved = null;
  const index = createFileSessionIndex({
    listRolloutFiles: async () => [{ path: 'a.jsonl', mtimeMs: 100 }],
    readRolloutFile: async () => rolloutJsonl([
      metaLine({ id: 's', cwd: '/r' }),
      applyPatchLine({ timestamp: '2026-05-16T00:00:00Z', patch: '*** Add File: a.txt' })
    ]),
    savePersistence: async (snapshot) => { saved = snapshot; }
  });
  await index.getSessionsForFile('/r/a.txt');
  // savePersistence is fire-and-forget; let the microtask queue drain.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(saved.version, 1);
  assert.ok(saved.fileStates['a.jsonl']);
  assert.equal(saved.fileStates['a.jsonl'].mtimeMs, 100);
  assert.equal(saved.fileStates['a.jsonl'].parsed.sessionId, 's');
});

test('loadPersistence rehydrates cached parses; unchanged files are not re-read', async () => {
  const persisted = {
    version: 1,
    fileStates: {
      'a.jsonl': {
        mtimeMs: 100,
        parsed: {
          sessionId: 'old',
          cwd: '/r',
          sessionTimestamp: '2026-05-10T00:00:00Z',
          touches: [{ op: 'add', relPath: 'a.txt', touchedAt: 1234 }]
        }
      }
    }
  };
  let readCalls = 0;
  const index = createFileSessionIndex({
    listRolloutFiles: async () => [{ path: 'a.jsonl', mtimeMs: 100 }],
    readRolloutFile: async () => { readCalls += 1; return ''; },
    loadPersistence: async () => persisted
  });
  const hits = await index.getSessionsForFile(path.resolve('/r', 'a.txt'));
  assert.equal(readCalls, 0, 'unchanged file must not be re-read');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, 'old');
});

test('changed mtime triggers a re-read of just that file', async () => {
  const persisted = {
    version: 1,
    fileStates: {
      'a.jsonl': { mtimeMs: 100, parsed: { sessionId: 'old', cwd: '/r', touches: [{ op: 'add', relPath: 'a.txt' }] } },
      'b.jsonl': { mtimeMs: 100, parsed: { sessionId: 'b-old', cwd: '/r', touches: [{ op: 'add', relPath: 'b.txt' }] } }
    }
  };
  let readCalls = [];
  const index = createFileSessionIndex({
    listRolloutFiles: async () => [
      { path: 'a.jsonl', mtimeMs: 200 }, // changed
      { path: 'b.jsonl', mtimeMs: 100 }  // unchanged
    ],
    readRolloutFile: async (p) => {
      readCalls.push(p);
      return rolloutJsonl([
        metaLine({ id: 'a-new', cwd: '/r' }),
        applyPatchLine({ timestamp: '2026-05-17T00:00:00Z', patch: '*** Update File: a.txt' })
      ]);
    },
    loadPersistence: async () => persisted
  });
  const hits = await index.getSessionsForFile(path.resolve('/r', 'a.txt'));
  assert.deepEqual(readCalls, ['a.jsonl'], 'only the changed file is re-read');
  assert.equal(hits[0].sessionId, 'a-new');
  // b.txt still served from cached parse
  const bHits = await index.getSessionsForFile(path.resolve('/r', 'b.txt'));
  assert.equal(bHits[0].sessionId, 'b-old');
});

test('files removed from the walk get dropped from fileStates', async () => {
  const persisted = {
    version: 1,
    fileStates: {
      'a.jsonl': { mtimeMs: 100, parsed: { sessionId: 's-a', cwd: '/r', touches: [{ op: 'add', relPath: 'a.txt' }] } },
      'gone.jsonl': { mtimeMs: 100, parsed: { sessionId: 's-gone', cwd: '/r', touches: [{ op: 'add', relPath: 'gone.txt' }] } }
    }
  };
  let saved = null;
  const index = createFileSessionIndex({
    listRolloutFiles: async () => [{ path: 'a.jsonl', mtimeMs: 100 }],
    readRolloutFile: async () => '',
    loadPersistence: async () => persisted,
    savePersistence: async (snap) => { saved = snap; }
  });
  // gone.txt should no longer resolve
  const goneHits = await index.getSessionsForFile(path.resolve('/r', 'gone.txt'));
  assert.equal(goneHits.length, 0);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(saved.fileStates['a.jsonl']);
  assert.ok(!saved.fileStates['gone.jsonl'], 'deleted file dropped from persisted snapshot');
});

test('persistence with wrong version is ignored (fresh scan)', async () => {
  const persisted = {
    version: 999,
    fileStates: { 'a.jsonl': { mtimeMs: 100, parsed: { sessionId: 'stale', cwd: '/r', touches: [{ op: 'add', relPath: 'a.txt' }] } } }
  };
  let readCalls = 0;
  const index = createFileSessionIndex({
    listRolloutFiles: async () => [{ path: 'a.jsonl', mtimeMs: 100 }],
    readRolloutFile: async () => {
      readCalls += 1;
      return rolloutJsonl([
        metaLine({ id: 'fresh', cwd: '/r' }),
        applyPatchLine({ timestamp: '2026-05-17T00:00:00Z', patch: '*** Add File: a.txt' })
      ]);
    },
    loadPersistence: async () => persisted
  });
  const hits = await index.getSessionsForFile(path.resolve('/r', 'a.txt'));
  assert.equal(readCalls, 1, 'wrong version means we re-read everything');
  assert.equal(hits[0].sessionId, 'fresh');
});

test('loadPersistence errors are swallowed; build continues from scratch', async () => {
  let readCalls = 0;
  const index = createFileSessionIndex({
    listRolloutFiles: async () => [{ path: 'a.jsonl', mtimeMs: 100 }],
    readRolloutFile: async () => { readCalls += 1; return ''; },
    loadPersistence: async () => { throw new Error('corrupted'); }
  });
  await index.getSessionsForFile('/anything');
  assert.equal(readCalls, 1);
});

test('savePersistence errors do not crash the build', async () => {
  const index = createFileSessionIndex({
    listRolloutFiles: async () => [{ path: 'a.jsonl', mtimeMs: 100 }],
    readRolloutFile: async () => '',
    savePersistence: async () => { throw new Error('disk full'); }
  });
  await index.getSessionsForFile('/anything');
  // Reached here without throwing — build absorbed the error.
  assert.ok(true);
});

test('after sync-complete invalidate, the next build reuses fileStates and stays incremental', async () => {
  const rollouts = {
    'a.jsonl': rolloutJsonl([
      metaLine({ id: 's-a', cwd: '/r' }),
      applyPatchLine({ timestamp: '2026-05-16T00:00:00Z', patch: '*** Add File: a.txt' })
    ])
  };
  let readCalls = 0;
  const index = createFileSessionIndex({
    listRolloutFiles: async () => [{ path: 'a.jsonl', mtimeMs: 100 }],
    readRolloutFile: async (name) => { readCalls += 1; return rollouts[name]; }
  });
  await index.getSessionsForFile(path.resolve('/r', 'a.txt'));
  assert.equal(readCalls, 1);
  index.invalidate();
  await index.getSessionsForFile(path.resolve('/r', 'a.txt'));
  // Same mtime → reused; no second read.
  assert.equal(readCalls, 1, 'invalidate must not force re-reads of unchanged files');
});

test('getFilesForSession returns files touched by the given session', async () => {
  const rollouts = {
    'a.jsonl': rolloutJsonl([
      metaLine({ id: 'sess-a', cwd: 'C:/repo' }),
      applyPatchLine({
        timestamp: '2026-05-16T10:00:00Z',
        patch: '*** Add File: src/new.js\n*** Update File: src/existing.js'
      })
    ]),
    'b.jsonl': rolloutJsonl([
      metaLine({ id: 'sess-b', cwd: 'C:/repo' }),
      applyPatchLine({
        timestamp: '2026-05-16T11:00:00Z',
        patch: '*** Update File: docs/readme.md'
      })
    ])
  };
  const index = createFileSessionIndex({
    listRolloutFiles: async () => Object.keys(rollouts).map((p) => ({ path: p, mtimeMs: 1 })),
    readRolloutFile: async (name) => rollouts[name]
  });
  const a = await index.getFilesForSession('sess-a');
  assert.equal(a.cwd, 'C:/repo');
  assert.deepEqual(a.files.map((f) => f.path).sort(), [
    path.resolve('C:/repo', 'src/existing.js'),
    path.resolve('C:/repo', 'src/new.js')
  ].sort());
  const b = await index.getFilesForSession('sess-b');
  assert.equal(b.files.length, 1);
  assert.match(b.files[0].path, /readme\.md$/);
});

test('getFilesForSession returns empty for unknown sessionId', async () => {
  const index = createFileSessionIndex({
    listRolloutFiles: async () => [],
    readRolloutFile: async () => ''
  });
  const r = await index.getFilesForSession('ghost');
  assert.deepEqual(r.files, []);
  assert.equal(r.cwd, null);
});

test('getFilesForSession respects limit', async () => {
  // Build a session that touched many files
  const patch = ['*** Begin Patch'];
  for (let i = 0; i < 20; i += 1) patch.push(`*** Add File: f${i}.txt`);
  patch.push('*** End Patch');
  const rollouts = {
    'big.jsonl': rolloutJsonl([
      metaLine({ id: 'big-sess', cwd: 'C:/r' }),
      applyPatchLine({ timestamp: '2026-05-16T10:00:00Z', patch: patch.join('\n') })
    ])
  };
  const index = createFileSessionIndex({
    listRolloutFiles: async () => [{ path: 'big.jsonl', mtimeMs: 1 }],
    readRolloutFile: async (name) => rollouts[name]
  });
  const r = await index.getFilesForSession('big-sess', { limit: 5 });
  assert.equal(r.files.length, 5);
});

test('getFilesForSession de-dupes paths (same file touched multiple times)', async () => {
  const rollouts = {
    'a.jsonl': rolloutJsonl([
      metaLine({ id: 'sess', cwd: 'C:/repo' }),
      applyPatchLine({ timestamp: '2026-05-16T10:00:00Z', patch: '*** Update File: src/foo.js' }),
      applyPatchLine({ timestamp: '2026-05-16T10:05:00Z', patch: '*** Update File: src/foo.js' }),
      applyPatchLine({ timestamp: '2026-05-16T10:10:00Z', patch: '*** Update File: src/bar.js' })
    ])
  };
  const index = createFileSessionIndex({
    listRolloutFiles: async () => [{ path: 'a.jsonl', mtimeMs: 1 }],
    readRolloutFile: async (name) => rollouts[name]
  });
  const r = await index.getFilesForSession('sess');
  assert.equal(r.files.length, 2);
  assert.deepEqual(
    r.files.map((f) => f.path).sort(),
    [path.resolve('C:/repo', 'src/bar.js'), path.resolve('C:/repo', 'src/foo.js')].sort()
  );
});

// ---- aggregateActivity ----

test('aggregateActivity buckets touches by UTC date, dedup-counts sessions/files/projects', async () => {
  const rollouts = {
    '/codex/a.jsonl': rolloutJsonl([
      metaLine({ id: 'sess-1', cwd: '/repo-A' }),
      applyPatchLine({ timestamp: '2026-05-15T10:00:00Z', patch: '*** Add File: src/x.js\n*** Update File: src/y.js' })
    ]),
    '/codex/b.jsonl': rolloutJsonl([
      metaLine({ id: 'sess-2', cwd: '/repo-A' }),
      applyPatchLine({ timestamp: '2026-05-15T14:00:00Z', patch: '*** Add File: docs/readme.md' })
    ]),
    '/codex/c.jsonl': rolloutJsonl([
      metaLine({ id: 'sess-3', cwd: '/repo-B' }),
      applyPatchLine({ timestamp: '2026-05-16T08:00:00Z', patch: '*** Add File: src/z.js' })
    ])
  };
  const index = createFileSessionIndex({
    listRolloutFiles: async () => Object.keys(rollouts).map((p) => ({ path: p, mtimeMs: 1 })),
    readRolloutFile: async (name) => rollouts[name]
  });
  const { days, totals } = await index.aggregateActivity();
  assert.equal(days.length, 2);
  // Most recent first
  assert.equal(days[0].date, '2026-05-16');
  assert.equal(days[1].date, '2026-05-15');
  // 2026-05-15: 2 sessions, 3 unique files, 1 project (/repo-A)
  assert.equal(days[1].sessionCount, 2);
  assert.equal(days[1].fileCount, 3);
  assert.equal(days[1].projectCount, 1);
  // Totals across both days: 3 sessions, 4 files, 2 projects
  assert.equal(totals.sessions, 3);
  assert.equal(totals.files, 4);
  assert.equal(totals.projects, 2);
});

test('aggregateActivity respects agentFilter (codex/claude)', async () => {
  const rollouts = {
    '/codex/a.jsonl': rolloutJsonl([
      metaLine({ id: 'codex-s', cwd: '/r' }),
      applyPatchLine({ timestamp: '2026-05-15T10:00:00Z', patch: '*** Add File: a.txt' })
    ]),
    '/claude/b.jsonl': rolloutJsonl([
      metaLine({ id: 'claude-s', cwd: '/r' }),
      applyPatchLine({ timestamp: '2026-05-15T11:00:00Z', patch: '*** Add File: b.txt' })
    ])
  };
  const index = createFileSessionIndex({
    listRolloutFiles: async () => Object.keys(rollouts).map((p) => ({ path: p, mtimeMs: 1 })),
    readRolloutFile: async (name) => rollouts[name],
    classifySourceFile: (p) => p.includes('codex') ? 'codex' : 'claude'
  });
  const codexOnly = await index.aggregateActivity({ agentFilter: 'codex' });
  assert.equal(codexOnly.totals.sessions, 1);
  assert.equal(codexOnly.days[0].byAgent.codex?.sessions, 1);
  assert.equal(codexOnly.days[0].byAgent.claude, undefined);
  const both = await index.aggregateActivity();
  assert.equal(both.totals.sessions, 2);
  assert.deepEqual(Object.keys(both.days[0].byAgent).sort(), ['claude', 'codex']);
});

test('aggregateActivity respects sinceMs cutoff', async () => {
  const rollouts = {
    'a.jsonl': rolloutJsonl([
      metaLine({ id: 'old', cwd: '/r' }),
      applyPatchLine({ timestamp: '2026-05-01T00:00:00Z', patch: '*** Add File: x' })
    ]),
    'b.jsonl': rolloutJsonl([
      metaLine({ id: 'new', cwd: '/r' }),
      applyPatchLine({ timestamp: '2026-05-16T00:00:00Z', patch: '*** Add File: y' })
    ])
  };
  const index = createFileSessionIndex({
    listRolloutFiles: async () => Object.keys(rollouts).map((p) => ({ path: p, mtimeMs: 1 })),
    readRolloutFile: async (name) => rollouts[name]
  });
  const sinceMs = Date.parse('2026-05-10T00:00:00Z');
  const result = await index.aggregateActivity({ sinceMs });
  assert.equal(result.days.length, 1);
  assert.equal(result.days[0].date, '2026-05-16');
  assert.equal(result.totals.sessions, 1);
});

test('aggregateActivity returns empty days when no touches match', async () => {
  const index = createFileSessionIndex({
    listRolloutFiles: async () => [],
    readRolloutFile: async () => ''
  });
  const result = await index.aggregateActivity();
  assert.deepEqual(result.days, []);
  assert.equal(result.totals.sessions, 0);
});

test('getStats returns null before first build, populated after', async () => {
  const index = createFileSessionIndex({
    listRolloutFiles: async () => ['x.jsonl'],
    readRolloutFile: async () => rolloutJsonl([
      metaLine({ id: 's', cwd: '/r' }),
      applyPatchLine({ timestamp: '2026-05-16T00:00:00Z', patch: '*** Add File: a' })
    ])
  });
  assert.equal(index.getStats(), null);
  await index.getSessionsForFile('/r/a');
  const stats = index.getStats();
  assert.equal(stats.fileCount, 1);
  assert.equal(stats.uniquePaths, 1);
  assert.ok(typeof stats.builtAt === 'number');
});
