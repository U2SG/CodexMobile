// NOTE: attachmentPreviewUrl emits `/api/local-image?path=…` URLs. That
// endpoint is part of Batch C (file / pdf preview) and isn't wired into the
// server yet. The function and its tests are valid; the rendered URL just
// won't resolve on the server until static-service.js lands. Until then,
// callers should fall back to whatever upload preview pipeline they had
// before (or skip rendering image thumbnails for these attachments).

export function isImageAttachment(attachment = {}) {
  const mimeType = String(attachment.mimeType || '').toLowerCase();
  return attachment.kind === 'image' || mimeType.startsWith('image/');
}

export function attachmentPreviewUrl(attachment = {}, token = '') {
  const imagePath = String(attachment.path || '').trim();
  if (!imagePath) {
    return '';
  }
  const tokenValue = String(token || '').trim();
  const tokenParam = tokenValue ? `&token=${encodeURIComponent(tokenValue)}` : '';
  return `/api/local-image?path=${encodeURIComponent(imagePath)}${tokenParam}`;
}
