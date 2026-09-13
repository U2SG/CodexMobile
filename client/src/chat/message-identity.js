// Identity helpers for user-authored chat messages.
//
// Upstream (flyyangX/CodexMobile@27b0533) keeps the implementation in
// shared/message-identity.js and exposes a thin re-export from
// client/src/chat/message-identity.js so both browser and node code can
// reuse it. Locally we don't yet have a server consumer, so the impl is
// inlined here. If a server module ever needs the same logic, hoist this
// to a shared/ module and turn this file back into a re-export shim.

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isMarkdownImageLine(line) {
  return /^!\[[^\]]*\]\((?:<[^>]*>|[^)]*?)\)\s*$/.test(String(line || '').trim());
}

function isLegacyImageAttachmentLine(line) {
  return /^[-*]\s*图片[:：]\s*.*?\s*\(.+\)\s*$/.test(String(line || '').trim());
}

function imageSourceFromLine(line) {
  const text = String(line || '').trim();
  const markdown = text.match(/^!\[[^\]]*\]\((?:<([^>]*)>|([^)]*?))\)\s*$/);
  if (markdown) {
    return normalizeWhitespace(markdown[1] || markdown[2]);
  }
  const legacy = text.match(/^[-*]\s*图片[:：]\s*.*?\s*\((.+)\)\s*$/);
  if (legacy) {
    return normalizeWhitespace(legacy[1]);
  }
  return '';
}

export function userMessageImageSignature(content) {
  return String(content || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(imageSourceFromLine)
    .filter(Boolean)
    .join('|');
}

export function userMessageIdentity(content) {
  const lines = String(content || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !isMarkdownImageLine(line) && !isLegacyImageAttachmentLine(line));
  return normalizeWhitespace(lines.join('\n').replace(/\n*附件路径[:：]\s*$/g, ''));
}

export function sameUserMessageContent(left, right) {
  const leftIdentity = userMessageIdentity(left);
  const rightIdentity = userMessageIdentity(right);
  if (!leftIdentity || !rightIdentity || leftIdentity !== rightIdentity) {
    return false;
  }
  const leftImages = userMessageImageSignature(left);
  const rightImages = userMessageImageSignature(right);
  return !leftImages || !rightImages || leftImages === rightImages;
}
