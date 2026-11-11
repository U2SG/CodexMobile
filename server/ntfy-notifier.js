// ntfy (https://ntfy.sh) as a push channel that does not depend on Google FCM:
// Android Chrome's Web Push cannot subscribe on phones without reachable Google
// services, while the ntfy app keeps its own connection to a self-hosted server.
// Configured with CODEXMOBILE_NTFY_URL=<server>/<topic>; unset disables it.

const PRIORITY = { success: 3, warning: 4, error: 4 };
const TAGS = { success: ['white_check_mark'], warning: ['warning'], error: ['x'] };

export function createNtfyNotifier({ url, token = '', fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (!url) return null;
  const target = new URL(url);
  const topic = target.pathname.replace(/^\/+|\/+$/g, '');
  if (!topic || topic.includes('/')) {
    throw new Error(`CODEXMOBILE_NTFY_URL must look like https://host/<topic>, got ${url}`);
  }
  const endpoint = `${target.origin}/`;

  return async function notify({ title, body, level = 'success' }) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        topic,
        title,
        message: body,
        priority: PRIORITY[level] ?? 3,
        tags: TAGS[level] || []
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      throw new Error(`ntfy responded ${response.status}`);
    }
  };
}
