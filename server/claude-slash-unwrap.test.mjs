// Unit test for the Claude Code CLI slash-command unwrap. The CLI rewrites
// a user input like `/simplify foo\nbar` into a three-tag storage block
// before logging it to the session file; the PWA would otherwise render
// that block verbatim. unwrapClaudeSlashCommand flattens it back.

import assert from 'node:assert/strict';
import test from 'node:test';
import { unwrapClaudeSlashCommand } from './codex-data.js';

test('unwraps the full block: message + name + args + trailing', () => {
  const input = [
    '<command-message>simplify</command-message>',
    '<command-name>/simplify</command-name>',
    '<command-args>需要对照一个FMS-1231和1232的需求</command-args>',
    '我不懂我在安卓端发了一条消息，为什么会变成这样'
  ].join('\n');
  assert.equal(
    unwrapClaudeSlashCommand(input),
    '/simplify 需要对照一个FMS-1231和1232的需求\n我不懂我在安卓端发了一条消息，为什么会变成这样'
  );
});

test('unwraps the args-only block (no trailing prose)', () => {
  const input = [
    '<command-message>simplify</command-message>',
    '<command-name>/simplify</command-name>',
    '<command-args> 不要那么多的测试</command-args>'
  ].join('\n');
  assert.equal(unwrapClaudeSlashCommand(input), '/simplify 不要那么多的测试');
});

test('unwraps the bare block (no args, no trailing)', () => {
  const input = [
    '<command-message>simplify</command-message>',
    '<command-name>/simplify</command-name>'
  ].join('\n');
  assert.equal(unwrapClaudeSlashCommand(input), '/simplify');
});

test('treats an empty <command-args> the same as no args', () => {
  const input = [
    '<command-message>simplify</command-message>',
    '<command-name>/simplify</command-name>',
    '<command-args></command-args>',
    '剩余文本'
  ].join('\n');
  assert.equal(unwrapClaudeSlashCommand(input), '/simplify\n剩余文本');
});

test('leaves a plain message untouched', () => {
  assert.equal(unwrapClaudeSlashCommand('看一下FMS-1231和1232'), '看一下FMS-1231和1232');
});

test('does not match when the block is mid-text (tags must start at column 0)', () => {
  const input = 'foo\n<command-message>simplify</command-message>\n<command-name>/simplify</command-name>';
  assert.equal(unwrapClaudeSlashCommand(input), input);
});

// Built-in commands like /clear emit the tags in a different order
// (<command-name> first) and indent the following tags, instead of the
// <command-message>-first form that /simplify uses.
test('unwraps a name-first block with indented tags (/clear shape)', () => {
  const input = [
    '<command-name>/clear</command-name>',
    '            <command-message>clear</command-message>',
    '            <command-args></command-args>'
  ].join('\n');
  assert.equal(unwrapClaudeSlashCommand(input), '/clear');
});

test('unwraps a name-first block with trailing prose', () => {
  const input = [
    '<command-name>/clear</command-name>',
    '            <command-message>clear</command-message>',
    '            <command-args></command-args>,还有'
  ].join('\n');
  assert.equal(unwrapClaudeSlashCommand(input), '/clear\n,还有');
});

test('unwraps a name-first block with args', () => {
  const input = [
    '<command-name>/foo</command-name>',
    '<command-args>bar baz</command-args>',
    '<command-message>foo</command-message>'
  ].join('\n');
  assert.equal(unwrapClaudeSlashCommand(input), '/foo bar baz');
});
