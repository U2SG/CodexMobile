import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeFileMentions,
  normalizeAttachments,
  parseMultipartFile,
  withAttachmentReferences,
  withFileMentionReferences,
  withImageAttachmentPreviews
} from './upload-service.js';

function multipartBody({ boundary, fieldName = 'file', fileName, mimeType, data }) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n`),
    Buffer.from(`Content-Type: ${mimeType}\r\n\r\n`),
    Buffer.from(data),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}

test('parseMultipartFile extracts and sanitizes an uploaded file', () => {
  const boundary = 'codexmobile-test-boundary';
  const body = multipartBody({
    boundary,
    fileName: '../bad:name.txt',
    mimeType: 'text/plain',
    data: 'hello'
  });

  const file = parseMultipartFile(body, `multipart/form-data; boundary=${boundary}`);

  assert.equal(file.fileName, 'bad_name.txt');
  assert.equal(file.mimeType, 'text/plain');
  assert.equal(file.data.toString('utf8'), 'hello');
});

test('normalizeAttachments keeps valid paths and splits image/file references', () => {
  const attachments = normalizeAttachments([
    { id: 1, name: '图[片].png', path: '/tmp/a image.png', kind: 'image', mimeType: 'image/png' },
    { name: 'brief.pdf', path: '/tmp/brief.pdf', kind: 'file', mimeType: 'application/pdf' },
    { name: 'missing-path' }
  ]);

  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].kind, 'image');
  assert.equal(attachments[1].kind, 'file');
  assert.equal(
    withImageAttachmentPreviews('看图', attachments),
    '看图\n\n![图片.png](</tmp/a image.png>)'
  );
  assert.equal(
    withAttachmentReferences('看文件', attachments),
    '看文件\n\n附件路径:\n- 图片: 图[片].png (/tmp/a image.png)\n- 文件: brief.pdf (/tmp/brief.pdf)'
  );
});

test('file mention references dedupe paths and append to the model message', () => {
  const mentions = normalizeFileMentions([
    { name: 'App.jsx', path: '/repo/client/src/App.jsx' },
    { name: 'duplicate.jsx', path: '/repo/client/src/App.jsx' },
    { path: '/repo/server/index.js' },
    { name: 'missing-path' }
  ]);

  assert.deepEqual(mentions, [
    { name: 'App.jsx', path: '/repo/client/src/App.jsx' },
    { name: 'index.js', path: '/repo/server/index.js' }
  ]);
  assert.equal(
    withFileMentionReferences('看这两个文件', mentions),
    '看这两个文件\n\n引用文件路径:\n- 文件: App.jsx (/repo/client/src/App.jsx)\n- 文件: index.js (/repo/server/index.js)'
  );
});
