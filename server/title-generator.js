// Generates short conversation titles via an OpenAI-compatible chat-completions endpoint.
// Pure module: callers inject `fetchFn`, `baseUrl`, `apiKey`, `model`. On any failure,
// returns a slice-based fallback so the caller never has to handle errors.

export const TITLE_MAX_LENGTH = 14;
const PROMPT_SOURCE_LIMIT = 800;
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 6000;

const PUNCTUATION_TRIM = /^[\s"'`「『《【\[(（"]+|[\s"'`」』》】\])）。．.,;:、!?！？"]+$/g;
const TITLE_PREFIX = /^\s*(?:title|标题)\s*[:：]\s*/i;

export function buildTitlePrompt(messageText) {
  const source = String(messageText || '').trim().slice(0, PROMPT_SOURCE_LIMIT);
  return [
    'Summarize the following user message into a chat thread title.',
    `Hard rules: at most ${TITLE_MAX_LENGTH} characters; same language as the message; no quotes, no trailing punctuation, no prefixes like "Title:"; nouns/verbs only.`,
    'Reply with the title only.',
    '',
    'Message:',
    source
  ].join('\n');
}

export function sanitizeTitle(value) {
  if (value === null || value === undefined) return '';
  let text = String(value).replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(TITLE_PREFIX, '');
  // Strip outer quotes/brackets and trailing punctuation iteratively.
  for (let i = 0; i < 3; i += 1) {
    const next = text.replace(PUNCTUATION_TRIM, '').trim();
    if (next === text) break;
    text = next;
  }
  if ([...text].length > TITLE_MAX_LENGTH) {
    text = [...text].slice(0, TITLE_MAX_LENGTH).join('');
  }
  return text;
}

export function fallbackSliceTitle(title, summary) {
  const value = String(title || summary || '').trim();
  if (!value) return '新对话';
  const chars = [...value];
  return chars.length > TITLE_MAX_LENGTH ? chars.slice(0, TITLE_MAX_LENGTH).join('') : value;
}

function pickApiKey(apiKey) {
  if (Array.isArray(apiKey)) {
    return apiKey.find((value) => typeof value === 'string' && value.trim()) || '';
  }
  return typeof apiKey === 'string' ? apiKey.trim() : '';
}

export async function generateTitle({
  messageText,
  baseUrl,
  apiKey,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchFn = globalThis.fetch
} = {}) {
  const fallback = fallbackSliceTitle(messageText, '');
  const trimmed = String(messageText || '').trim();
  const key = pickApiKey(apiKey);

  if (!trimmed || !baseUrl || !key) {
    return { title: fallback, source: 'fallback', reason: !trimmed ? 'empty-message' : !baseUrl ? 'no-base-url' : 'no-api-key' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 32,
        messages: [
          { role: 'system', content: 'You write concise titles for chat threads.' },
          { role: 'user', content: buildTitlePrompt(trimmed) }
        ]
      })
    });
    if (!response.ok) {
      return { title: fallback, source: 'fallback', reason: `http-${response.status}` };
    }
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content;
    const title = sanitizeTitle(raw);
    if (!title) {
      return { title: fallback, source: 'fallback', reason: 'empty-response' };
    }
    return { title, source: 'model' };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'timeout' : `error:${error?.message || 'unknown'}`;
    return { title: fallback, source: 'fallback', reason };
  } finally {
    clearTimeout(timer);
  }
}
