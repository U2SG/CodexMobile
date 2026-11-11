const TOKEN_KEY = 'codexmobile.deviceToken';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// The device token was revoked or the server's auth state was reset. Without
// this the app kept retrying forever behind a "disconnected" badge instead of
// returning to the pairing screen.
export const AUTH_LOST_EVENT = 'codexmobile:auth-lost';

// Carries the token that was rejected: a late 401 from a request sent with
// an old token must not sign out a device that has since re-paired.
export function notifyAuthLost(rejectedToken) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTH_LOST_EVENT, { detail: { token: rejectedToken } }));
  }
}

// A GET that stalls after a network switch never settles on iOS, which
// leaves pollers waiting on it forever. The deadline only has to beat a dead
// socket, so it sits above the slowest legitimate reads (search, git history,
// a desktop thread read behind IPC timeouts). Writes keep no deadline: a slow
// send must not be retried as a duplicate turn.
const GET_TIMEOUT_MS = 45_000;

function requestSignal(options) {
  const method = String(options.method || 'GET').toUpperCase();
  if (options.signal || method !== 'GET' || typeof AbortSignal.timeout !== 'function') {
    return options.signal;
  }
  return AbortSignal.timeout(GET_TIMEOUT_MS);
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      signal: requestSignal(options),
      body:
        options.body && !(options.body instanceof FormData) && typeof options.body !== 'string'
          ? JSON.stringify(options.body)
          : options.body
    });
  } catch (error) {
    // No response at all: the request may or may not have reached the server.
    const failure = error?.name === 'TimeoutError' ? new Error('请求超时，请检查网络后重试') : error;
    if (failure && typeof failure === 'object' && error?.name !== 'AbortError') failure.network = true;
    throw failure;
  }

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // A proxy/gateway HTML error page: keep the status code visible.
    if (!response.ok) throw httpError(`Request failed: ${response.status}`, response.status);
    throw new Error('Invalid JSON response');
  }
  if (!response.ok) {
    if (response.status === 401 && token) notifyAuthLost(token);
    throw httpError(data.error || `Request failed: ${response.status}`, response.status);
  }
  return data;
}

export async function apiBlobFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(path, {
    ...options,
    headers,
    body:
      options.body && !(options.body instanceof FormData) && typeof options.body !== 'string'
        ? JSON.stringify(options.body)
        : options.body
  });

  if (!response.ok) {
    const text = await response.text();
    let message = `Request failed: ${response.status}`;
    try {
      const data = text ? JSON.parse(text) : {};
      message = data.error || message;
    } catch {
      message = text || message;
    }
    throw new Error(message);
  }

  return response.blob();
}

export function realtimeVoiceWebsocketUrl() {
  const token = encodeURIComponent(getToken());
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/realtime?token=${token}`;
}
