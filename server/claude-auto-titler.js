// Background auto-titler for Claude sessions started in the terminal.
//
// App-initiated sessions get an LLM title when their first turn completes (see
// chat-auto-title.js). Terminal-initiated `claude` sessions never hit that
// path, so without this they show the first user line sliced to 52 chars. On
// each sync this debounces a small background pass: for sessions that still
// lack a locked title, read the rollout's titleable text, ask the title model
// for a ≤14-char summary, and write a locked mobile-sessions stub. Once locked,
// a session leaves the candidate list, so the work naturally drains to zero.
//
// Guards: an in-flight set (no duplicate work for one id) and a give-up set
// (a session that yields no source or whose title call fails is not retried
// this process — never hammer a down endpoint, never loop on empty content).

export function createClaudeAutoTitler({
  isEnabled,
  listCandidates,
  readTitleSource,
  generateTitle,
  getConfig,
  renameTitle,
  onTitled,
  model,
  timeoutMs,
  maxPerRun = 5,
  debounceMs = 1500,
  logger = console
} = {}) {
  const inFlight = new Set();
  const giveUp = new Set();
  let timer = null;
  let running = false;

  async function runOnce() {
    if (running || !isEnabled()) return;
    running = true;
    try {
      const candidates = listCandidates()
        .filter((s) => s.filePath && !inFlight.has(s.id) && !giveUp.has(s.id))
        .slice(0, maxPerRun);
      if (!candidates.length) return;

      const config = await getConfig();
      // `model` may be an (async) getter so a .env edit to the title model
      // takes effect on the next run without a server restart.
      const modelValue = typeof model === 'function' ? await model() : model;
      let titled = 0;
      for (const session of candidates) {
        inFlight.add(session.id);
        try {
          const source = await readTitleSource(session.filePath);
          if (!source) {
            giveUp.add(session.id);
            continue;
          }
          const result = await generateTitle({
            messageText: source,
            baseUrl: config.baseUrl,
            apiKey: config.apiKeys,
            model: modelValue,
            timeoutMs
          });
          if (result.source === 'model' && result.title) {
            await renameTitle({ id: session.id, projectPath: session.projectPath, title: result.title });
            titled += 1;
          } else {
            // Endpoint/config failure (502, timeout, no key): stop retrying so
            // we don't re-hit a broken endpoint on every sync.
            giveUp.add(session.id);
          }
        } catch (error) {
          giveUp.add(session.id);
          logger?.warn?.(`[claude-title] backfill failed session=${session.id}: ${error.message}`);
        } finally {
          inFlight.delete(session.id);
        }
      }
      if (titled) {
        await onTitled();
        schedule(); // more may remain beyond maxPerRun
      }
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (timer || !isEnabled()) return;
    timer = setTimeout(() => {
      timer = null;
      runOnce().catch((error) => logger?.warn?.(`[claude-title] run failed: ${error.message}`));
    }, debounceMs);
    if (timer.unref) timer.unref();
  }

  return { schedule, runOnce };
}
