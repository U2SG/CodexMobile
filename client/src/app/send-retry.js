// Retry policy for /api/chat/send. Only failures where the request may never
// have reached the server (no response, or a gateway error while the service
// restarts) are retried; the server dedupes by clientTurnId, so a retry of a
// request that did arrive returns the original turn instead of a second one.

const RETRIABLE_STATUS = new Set([502, 503, 504]);
export const SEND_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000];

export function isRetriableSendError(error) {
  return Boolean(error?.network) || RETRIABLE_STATUS.has(Number(error?.status));
}

// Resolves after `ms`, or earlier when the browser reports it is back online
// or the page becomes visible again (a phone waking up is the common case).
export function waitForRetry(ms, target = globalThis) {
  return new Promise((resolve) => {
    const doc = target.document;
    const done = () => {
      clearTimeout(timer);
      target.removeEventListener?.('online', done);
      doc?.removeEventListener?.('visibilitychange', onVisible);
      resolve();
    };
    const onVisible = () => {
      if (!doc.hidden) done();
    };
    const timer = setTimeout(done, ms);
    target.addEventListener?.('online', done);
    doc?.addEventListener?.('visibilitychange', onVisible);
  });
}

export async function sendWithRetry(send, {
  delays = SEND_RETRY_DELAYS_MS,
  wait = waitForRetry,
  onRetry = () => {},
  shouldContinue = () => true
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (!isRetriableSendError(error) || attempt >= delays.length || !shouldContinue()) {
        throw error;
      }
      onRetry({ attempt: attempt + 1, error });
      await wait(delays[attempt]);
    }
  }
}
