import path from 'node:path';
import { gzipSync } from 'node:zlib';

export const MAX_JSON_BYTES = 2 * 1024 * 1024;

export const DEFAULT_COMPRESSIBLE_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.css',
  '.json',
  '.webmanifest',
  '.svg'
]);

export function acceptsGzip(req) {
  return String(req.headers['accept-encoding'] || '')
    .split(',')
    .some((value) => value.trim().toLowerCase().startsWith('gzip'));
}

export function staticCacheControl(ext, filePath = '') {
  if (ext === '.html') {
    return 'no-store';
  }
  const normalized = filePath.split(path.sep).join('/');
  if (normalized.includes('/assets/')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=3600';
}

export function sendStaticContent(req, res, status, content, headers, ext, {
  compressibleExtensions = DEFAULT_COMPRESSIBLE_EXTENSIONS
} = {}) {
  let body = content;
  const nextHeaders = { ...headers };
  if (content.length >= 1024 && compressibleExtensions.has(ext) && acceptsGzip(req)) {
    body = gzipSync(content);
    nextHeaders['content-encoding'] = 'gzip';
    nextHeaders.vary = nextHeaders.vary ? `${nextHeaders.vary}, Accept-Encoding` : 'Accept-Encoding';
  }
  nextHeaders['content-length'] = body.length;
  res.writeHead(status, nextHeaders);
  res.end(body);
}

export function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

export function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(html);
}

export function htmlEscape(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function remoteAddress(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
}

export function readBody(req, { maxBytes = MAX_JSON_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let body = '';
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      body += chunk;
      if (body.length > maxBytes) {
        aborted = true;
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (aborted) return;
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Buffer variant of readBody for multipart / binary uploads. readBody parses
// JSON and is text-only; readBuffer streams the raw bytes into a Buffer so
// upload-service can pass them to parseMultipartFile. Settled flag guards
// against double-reject when the 'error' event fires after we already
// rejected for "Upload too large".
export function readBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) {
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        req.resume();
        reject(new Error('Upload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}
