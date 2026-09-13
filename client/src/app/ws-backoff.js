// Exponential backoff with full jitter, used by useAppWebSocket reconnect.
//
// The base sequence (no jitter) is initial * multiplier^attempt, capped at max.
// Each computed delay is then perturbed by ±jitter (fractional, e.g. 0.25 → ±25%).
// Reset is called when the connection proves itself alive (first server frame).

const DEFAULTS = {
  initial: 500,
  max: 30000,
  multiplier: 2,
  jitter: 0.25
};

export function createBackoff(options = {}) {
  const { initial, max, multiplier, jitter } = { ...DEFAULTS, ...options };
  let attempt = 0;

  return {
    next(random = Math.random) {
      const base = Math.min(initial * Math.pow(multiplier, attempt), max);
      attempt += 1;
      if (!jitter) {
        return base;
      }
      const spread = base * jitter;
      const offset = (random() * 2 - 1) * spread;
      return Math.max(0, Math.round(base + offset));
    },
    reset() {
      attempt = 0;
    },
    get attempts() {
      return attempt;
    }
  };
}
