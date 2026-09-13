import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexTurnInput,
  imageMarkdownFromCodexImageGeneration,
  useLegacyImageGenerator
} from './codex-native-images.js';

test('routes image generation to native Codex by default', () => {
  assert.equal(useLegacyImageGenerator({}), false);
});

test('keeps the legacy direct image API behind an explicit flag', () => {
  assert.equal(useLegacyImageGenerator({ CODEXMOBILE_IMAGE_ROUTE: 'legacy' }), true);
  assert.equal(useLegacyImageGenerator({ CODEXMOBILE_IMAGE_MODE: 'direct' }), true);
});

test('passes uploaded images to Codex app-server as localImage input items', () => {
  const input = buildCodexTurnInput({
    message: '参考这张图重新生成一张海报',
    attachments: [
      { kind: 'image', path: '/tmp/example.png' },
      { kind: 'file', path: '/tmp/readme.md' }
    ]
  });

  assert.deepEqual(input, [
    { type: 'text', text: '参考这张图重新生成一张海报', text_elements: [] },
    { type: 'localImage', path: '/tmp/example.png' }
  ]);
});

test('renders native Codex saved image paths as Markdown images', () => {
  assert.equal(
    imageMarkdownFromCodexImageGeneration({ savedPath: '/tmp/generated image.png' }),
    '![生成图片](</tmp/generated image.png>)'
  );
});
