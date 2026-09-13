import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildTitlePrompt,
  fallbackSliceTitle,
  generateTitle,
  sanitizeTitle,
  TITLE_MAX_LENGTH
} from './title-generator.js';

test('TITLE_MAX_LENGTH is 14', () => {
  assert.equal(TITLE_MAX_LENGTH, 14);
});

test('buildTitlePrompt embeds the trimmed user message', () => {
  const prompt = buildTitlePrompt('  请帮我看一下这段代码哪里写得不对  ');
  assert.match(prompt, /请帮我看一下这段代码哪里写得不对/);
  assert.doesNotMatch(prompt, /  请帮我/);
});

test('buildTitlePrompt requests ≤14 chars and matches user language', () => {
  const prompt = buildTitlePrompt('hello world');
  assert.match(prompt, /14/);
  assert.match(prompt, /language|语言/i);
});

test('buildTitlePrompt truncates very long source messages to keep prompt small', () => {
  const long = 'a'.repeat(5000);
  const prompt = buildTitlePrompt(long);
  assert.ok(prompt.length < 2000, `prompt should be capped, got ${prompt.length}`);
});

test('sanitizeTitle strips quotes, trailing punctuation, and trims', () => {
  assert.equal(sanitizeTitle('  "看代码错误"  '), '看代码错误');
  assert.equal(sanitizeTitle('"How to fix"'), 'How to fix');
  assert.equal(sanitizeTitle('「日报模板」。'), '日报模板');
  assert.equal(sanitizeTitle("'A B C'"), 'A B C');
});

test('sanitizeTitle clamps to TITLE_MAX_LENGTH', () => {
  const result = sanitizeTitle('一二三四五六七八九十一二三四五六七');
  assert.ok(result.length <= TITLE_MAX_LENGTH);
});

test('sanitizeTitle drops a leading "Title:" or "标题：" prefix', () => {
  assert.equal(sanitizeTitle('Title: Bug fix plan'), 'Bug fix plan');
  assert.equal(sanitizeTitle('标题：写日报'), '写日报');
  assert.equal(sanitizeTitle('title:hello'), 'hello');
});

test('sanitizeTitle returns empty string for empty / whitespace input', () => {
  assert.equal(sanitizeTitle(''), '');
  assert.equal(sanitizeTitle('   '), '');
  assert.equal(sanitizeTitle(null), '');
  assert.equal(sanitizeTitle(undefined), '');
});

test('sanitizeTitle collapses internal whitespace and newlines', () => {
  assert.equal(sanitizeTitle('hi\n\nthere   you'), 'hi there you');
});

test('fallbackSliceTitle uses summary when title empty', () => {
  assert.equal(fallbackSliceTitle('', '一二三四五六七八九十一二三四五六七八'), '一二三四五六七八九十一二三四');
});

test('fallbackSliceTitle returns "新对话" when both empty', () => {
  assert.equal(fallbackSliceTitle('', ''), '新对话');
  assert.equal(fallbackSliceTitle(null, null), '新对话');
});

test('fallbackSliceTitle prefers title over summary', () => {
  assert.equal(fallbackSliceTitle('好标题', 'long summary text'), '好标题');
});

function makeFetchOk(content) {
  return async () => ({
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content } }] };
    }
  });
}

test('generateTitle returns sanitized model output on success', async () => {
  const result = await generateTitle({
    messageText: 'fix login bug',
    baseUrl: 'http://x',
    apiKey: 'k',
    model: 'gpt-x',
    fetchFn: makeFetchOk('"修复登录错误"')
  });
  assert.equal(result.title, '修复登录错误');
  assert.equal(result.source, 'model');
});

test('generateTitle falls back to slice when no API key', async () => {
  const result = await generateTitle({
    messageText: '一二三四五六七八九十',
    baseUrl: 'http://x',
    apiKey: '',
    fetchFn: () => { throw new Error('should not be called'); }
  });
  assert.equal(result.source, 'fallback');
  assert.equal(result.title, '一二三四五六七八九十');
});

test('generateTitle falls back when fetch throws', async () => {
  const result = await generateTitle({
    messageText: 'compact this',
    baseUrl: 'http://x',
    apiKey: 'k',
    fetchFn: async () => { throw new Error('connection refused'); }
  });
  assert.equal(result.source, 'fallback');
  assert.equal(result.title, 'compact this');
});

test('generateTitle falls back on non-2xx status', async () => {
  const result = await generateTitle({
    messageText: 'hi',
    baseUrl: 'http://x',
    apiKey: 'k',
    fetchFn: async () => ({ ok: false, status: 500, async json() { return { error: 'boom' }; } })
  });
  assert.equal(result.source, 'fallback');
});

test('generateTitle falls back when model returns empty content', async () => {
  const result = await generateTitle({
    messageText: 'meeting recap',
    baseUrl: 'http://x',
    apiKey: 'k',
    fetchFn: makeFetchOk('   ')
  });
  assert.equal(result.source, 'fallback');
  assert.equal(result.title, 'meeting recap');
});

test('generateTitle falls back on timeout', async () => {
  const result = await generateTitle({
    messageText: 'long task',
    baseUrl: 'http://x',
    apiKey: 'k',
    timeoutMs: 30,
    fetchFn: async (_url, opts) => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 500);
        opts?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); });
      });
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content: 'never' } }] }; } };
    }
  });
  assert.equal(result.source, 'fallback');
});

test('generateTitle posts to /chat/completions with bearer token', async () => {
  const captured = {};
  await generateTitle({
    messageText: 'hi',
    baseUrl: 'http://example/v1',
    apiKey: 'sk-test',
    model: 'small-model',
    fetchFn: async (url, opts) => {
      captured.url = url;
      captured.headers = opts.headers;
      captured.body = JSON.parse(opts.body);
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content: 'hi' } }] }; } };
    }
  });
  assert.equal(captured.url, 'http://example/v1/chat/completions');
  assert.equal(captured.headers.authorization, 'Bearer sk-test');
  assert.equal(captured.body.model, 'small-model');
  assert.ok(Array.isArray(captured.body.messages));
});

test('generateTitle uses fallback when messageText is empty', async () => {
  const result = await generateTitle({
    messageText: '',
    baseUrl: 'http://x',
    apiKey: 'k',
    fetchFn: () => { throw new Error('should not be called'); }
  });
  assert.equal(result.title, '新对话');
  assert.equal(result.source, 'fallback');
});

test('generateTitle uses fallback when first API key in array is empty', async () => {
  const result = await generateTitle({
    messageText: 'task',
    baseUrl: 'http://x',
    apiKey: ['', '', undefined],
    fetchFn: () => { throw new Error('should not be called'); }
  });
  assert.equal(result.source, 'fallback');
});

test('generateTitle picks first non-empty key from apiKey array', async () => {
  const captured = {};
  await generateTitle({
    messageText: 'task',
    baseUrl: 'http://x',
    apiKey: ['', 'sk-real', 'sk-other'],
    fetchFn: async (_url, opts) => {
      captured.headers = opts.headers;
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content: 'ok' } }] }; } };
    }
  });
  assert.equal(captured.headers.authorization, 'Bearer sk-real');
});
