import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sameUserMessageContent,
  userMessageIdentity,
  userMessageImageSignature
} from './message-identity.js';

test('userMessageIdentity ignores image preview markdown while preserving text', () => {
  assert.equal(
    userMessageIdentity('看这张图\n\n![截图](/tmp/uploads/a.png)'),
    '看这张图'
  );
});

test('sameUserMessageContent matches optimistic image preview to synced plain text', () => {
  assert.equal(
    sameUserMessageContent('看这张图\n\n![截图](/tmp/uploads/a.png)', '看这张图'),
    true
  );
});

test('sameUserMessageContent keeps different image previews distinct when both sides include images', () => {
  assert.equal(
    sameUserMessageContent('看这张图\n\n![截图](/tmp/uploads/a.png)', '看这张图\n\n![截图](/tmp/uploads/b.png)'),
    false
  );
});

test('userMessageImageSignature extracts legacy image attachment paths', () => {
  assert.equal(
    userMessageImageSignature('- 图片: 截图 (/tmp/uploads/a.png)'),
    '/tmp/uploads/a.png'
  );
});
