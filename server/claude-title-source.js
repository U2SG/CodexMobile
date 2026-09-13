import fsSync from 'node:fs';
import readline from 'node:readline';

// Shared helper: pick a substantive line from a Claude session to title/summarize.
//
// Claude rollouts inject non-conversational "user" turns — slash-command
// wrappers, local-command stdout, task notifications, interruption markers,
// compact-continuation preambles. Using the *last* such line as a title (the
// old behavior) yields garbage like "<task-notification>…" or "/clear". This
// reduces a raw user-message string to its titleable content, or '' if the
// line carries no topic. Used by both parseClaudeSessionMetadata (title
// fallback) and scripts/retitle-claude-sessions.mjs (LLM source text).

const JUNK_PREFIXES = [
  '<task-notification>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<bash-stdout>',
  '<bash-stderr>'
];

const JUNK_PATTERNS = [
  /^\[Request interrupted/i,
  /^This session is being continued from a previous/i,
  /^Caveat: The messages below/i,
  /^\(no content\)$/i
];

const IMAGE_ONLY = /^(\[Image #\d+\]\s*)+$/;
const LEADING_SLASH_COMMAND = /^\/[A-Za-z][\w:-]*\s*/;

export function cleanUserTextForTitle(rawText) {
  let text = String(rawText || '').replace(/\r/g, '').trim();
  if (!text) return '';
  for (const prefix of JUNK_PREFIXES) {
    if (text.startsWith(prefix)) return '';
  }
  for (const pattern of JUNK_PATTERNS) {
    if (pattern.test(text)) return '';
  }
  if (IMAGE_ONLY.test(text)) return '';
  // A bare slash command ("/clear") is junk; one with an argument
  // ("/html-anything explain this pr") keeps the argument as the topic.
  if (text.startsWith('/')) {
    const remainder = text.replace(LEADING_SLASH_COMMAND, '').trim();
    if (!remainder || IMAGE_ONLY.test(remainder)) return '';
    text = remainder;
  }
  // Drop leftover image placeholders so they don't pad a real line.
  text = text.replace(/\[Image #\d+\]/g, '').replace(/\s+/g, ' ').trim();
  return text;
}

// A cleaned line that is still a pasted log / HTTP request / stack trace rather
// than the user's question. Used to skip past an opening paste when choosing
// the message to title — callers must fall back to the first substantive line
// if every candidate looks like a paste, so content is never lost.
const PASTE_SHAPES = [
  /^\[?\d{1,2}:\d{2}:\d{2}\b/,                 // [10:07:23 ...] log timestamp
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/,         // ISO timestamp log
  /^(GET|POST|PUT|DELETE|PATCH|HEAD)\s+\/?\S/i, // HTTP request line
  /^(INF|INFO|WRN|WARN|ERR|ERROR|DBG|DEBUG|TRACE|FATAL)\b/i,
  /^(at\s+\S+\(|Traceback \(most recent|\s*File ")/,  // stack traces
  /^[{\[]/                                      // raw JSON/array dump
];

export function looksLikePaste(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return PASTE_SHAPES.some((re) => re.test(t));
}

function extractContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : (part?.type && /text/.test(part.type) ? part.text || '' : '')))
    .filter(Boolean)
    .join('\n');
}

// Read a Claude rollout (.jsonl) in chronological order and return the text to
// feed the title model: the first substantive user turn — preferring one that
// is not a log/HTTP/code paste, falling back to the first substantive turn so
// content is never lost — joined with the assistant reply that followed it.
// Returns '' when the session has no titleable content (e.g. only /clear).
const MAX_OPENING_TURNS = 6;
const SOURCE_LIMIT = 800;
export async function readClaudeTitleSource(filePath) {
  if (!filePath || !fsSync.existsSync(filePath)) return '';
  const rl = readline.createInterface({ input: fsSync.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  const turns = []; // { user, assistant }
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type === 'user' && !entry.isMeta && entry.message?.role === 'user') {
        const cleaned = cleanUserTextForTitle(extractContent(entry.message.content));
        if (cleaned) {
          turns.push({ user: cleaned, assistant: '' });
          if (turns.length >= MAX_OPENING_TURNS) break;
        }
        continue;
      }
      if (turns.length && !turns[turns.length - 1].assistant && entry?.type === 'assistant' && entry.message?.role === 'assistant') {
        const text = extractContent(entry.message.content).trim();
        if (text && text !== 'No response requested.') turns[turns.length - 1].assistant = text;
      }
    }
  } finally {
    rl.close();
  }
  if (!turns.length) return '';
  const chosen = turns.find((t) => !looksLikePaste(t.user)) || turns[0];
  return [chosen.user, chosen.assistant].filter(Boolean).join('\n\n').slice(0, SOURCE_LIMIT);
}
