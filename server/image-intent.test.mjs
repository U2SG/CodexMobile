import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeImageIntent, isImageRequest } from './image-generator.js';

test('high confidence image prompts auto-route to image generation', () => {
  const analysis = analyzeImageIntent('生成一张图片：赛博城市夜景');
  assert.equal(analysis.intent, 'generate');
  assert.equal(analysis.confidence, 'high');
  assert.equal(isImageRequest('create an image of a glass house'), true);
});

test('ambiguous visual design prompts require confirmation', () => {
  const analysis = analyzeImageIntent('帮我设计一个 logo 方案');
  assert.equal(analysis.intent, 'generate');
  assert.equal(analysis.confidence, 'medium');
  assert.equal(isImageRequest('帮我设计一个 logo 方案'), false);
});

test('image attachments with edit verbs are high confidence edits', () => {
  const analysis = analyzeImageIntent('把背景换成白色', [
    { kind: 'image', path: '/tmp/reference.png' }
  ]);
  assert.equal(analysis.intent, 'edit');
  assert.equal(analysis.confidence, 'high');
});
