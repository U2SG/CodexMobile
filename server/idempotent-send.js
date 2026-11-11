// The phone retries a send whose response it never got (network drop,
// gateway 502 while the service restarts). The first request may already have
// started the turn, so a retry carrying the same clientTurnId must get the
// original result instead of starting a second turn. In-flight requests are
// shared; failures are forgotten so a real retry can still go through.
export function createIdempotentRunner({ ttlMs = 10 * 60 * 1000, maxEntries = 200, now = () => Date.now() } = {}) {
  const entries = new Map();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of entries) {
      if (entry.settled && entry.settledAt < cutoff) entries.delete(key);
    }
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  return async function run(key, task) {
    if (!key) return task();
    prune();
    const existing = entries.get(key);
    if (existing) {
      const result = await existing.promise;
      return result && typeof result === 'object' ? { ...result, duplicate: true } : result;
    }
    const entry = { promise: null, settled: false, settledAt: 0 };
    entry.promise = Promise.resolve().then(task);
    entries.set(key, entry);
    try {
      const result = await entry.promise;
      entry.settled = true;
      entry.settledAt = now();
      return result;
    } catch (error) {
      entries.delete(key);
      throw error;
    }
  };
}
