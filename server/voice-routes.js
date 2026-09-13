// Voice transcribe + synthesize routes. Agent-agnostic (works the same on
// codex and claude routes — both rely on the same OpenAI-compatible
// upstream config from /api/status). Extracted from server/index.js
// (Batch G R26).
//
// Inputs (factory):
//   transcribeAudio    — from ./voice-transcriber.js
//   synthesizeSpeech   — from ./voice-speaker.js
//   readVoiceUpload    — from ./upload-service.js (multipart audio parse)
//   getCacheSnapshot   — from ./codex-data.js (provides upstream config)
//   remoteAddress      — from ./http-utils.js (for log lines)
//
// Returns: async handle(req, res, ctx) → true if matched, false otherwise.

import { readBody, sendJson } from './http-utils.js';

const SK_KEY_PATTERN = /sk-[A-Za-z0-9._-]+/g;
const SK_HIDDEN_PATTERN = /sk-\[hidden\][A-Za-z0-9*._-]*/g;

function sanitizeProviderMessage(raw, fallback) {
  return String(raw || fallback)
    .replace(SK_HIDDEN_PATTERN, 'sk-[hidden]')
    .replace(SK_KEY_PATTERN, 'sk-[hidden]');
}

export function createVoiceRoutes({
  transcribeAudio,
  synthesizeSpeech,
  readVoiceUpload,
  getCacheSnapshot,
  remoteAddress
}) {
  if (typeof transcribeAudio !== 'function') throw new Error('createVoiceRoutes: transcribeAudio is required');
  if (typeof synthesizeSpeech !== 'function') throw new Error('createVoiceRoutes: synthesizeSpeech is required');
  if (typeof readVoiceUpload !== 'function') throw new Error('createVoiceRoutes: readVoiceUpload is required');
  if (typeof getCacheSnapshot !== 'function') throw new Error('createVoiceRoutes: getCacheSnapshot is required');
  if (typeof remoteAddress !== 'function') throw new Error('createVoiceRoutes: remoteAddress is required');

  return async function handle(req, res, ctx) {
    const { method, pathname } = ctx;

    if (method === 'POST' && pathname === '/api/voice/transcribe') {
      const startedAt = Date.now();
      try {
        const audio = await readVoiceUpload(req);
        const config = getCacheSnapshot().config || {};
        const result = await transcribeAudio(audio, config);
        console.log(`[voice] transcribed size=${audio.data.length} mime=${audio.mimeType} provider=${result.provider} model=${result.model} remote=${remoteAddress(req)}`);
        sendJson(res, 200, { text: result.text || '', durationMs: Date.now() - startedAt });
      } catch (error) {
        const statusCode = error.statusCode || 502;
        const providerInfo = error.providerHost ? ` provider=${error.providerHost}` : '';
        const safeMessage = sanitizeProviderMessage(error.message, '语音转写失败');
        console.warn(`[voice] transcribe failed status=${statusCode}${providerInfo} remote=${remoteAddress(req)} message=${safeMessage}`);
        sendJson(res, statusCode, { error: safeMessage || '语音转写失败' });
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/voice/speech') {
      const startedAt = Date.now();
      try {
        const body = await readBody(req);
        const config = getCacheSnapshot().config || {};
        const result = await synthesizeSpeech(body.text, config);
        console.log(`[voice] synthesized bytes=${result.data.length} provider=${result.provider} model=${result.model} voice=${result.voice} remote=${remoteAddress(req)}`);
        res.writeHead(200, {
          'content-type': result.mimeType,
          'content-length': result.data.length,
          'cache-control': 'no-store',
          'x-codexmobile-duration-ms': String(Date.now() - startedAt)
        });
        res.end(result.data);
      } catch (error) {
        const statusCode = error.statusCode || 502;
        const safeMessage = sanitizeProviderMessage(error.message, '语音合成失败');
        console.warn(`[voice] speech failed status=${statusCode} remote=${remoteAddress(req)} message=${safeMessage}`);
        sendJson(res, statusCode, { error: safeMessage || '语音合成失败' });
      }
      return true;
    }

    return false;
  };
}
