import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

import { DEFAULT_OPENAI_COMPATIBLE_BASE_URL, openAICompatibleConfig } from './provider-api.js';

const DEFAULT_SPEECH_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_SPEECH_VOICE = 'coral';
const DEFAULT_SPEECH_FORMAT = 'mp3';
const SPEECH_TIMEOUT_MS = Number(process.env.CODEXMOBILE_SPEECH_TIMEOUT_MS || 120000);
const LOCAL_SPEECH_TIMEOUT_MS = Number(process.env.CODEXMOBILE_SPEECH_LOCAL_TIMEOUT_MS || 45000);
const SPEECH_MAX_INPUT_CHARS = Number(process.env.CODEXMOBILE_SPEECH_MAX_INPUT_CHARS || 4000);
const EDGE_SPEECH_TIMEOUT_MS = Number(process.env.CODEXMOBILE_SPEECH_EDGE_TIMEOUT_MS || 30000);
const EDGE_SPEECH_PROVIDER = 'edge-tts';
const EDGE_TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_GEC_VERSION = process.env.CODEXMOBILE_SPEECH_EDGE_GEC_VERSION || '1-143.0.3650.75';
const DEFAULT_EDGE_SPEECH_VOICE = 'Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoxiaoNeural)';
const EDGE_SPEECH_FORMAT = 'webm-24khz-16bit-mono-opus';
const EDGE_SPEECH_MIME_TYPE = 'audio/webm; codecs=opus';
const LOCAL_SPEECH_PROVIDER = 'windows-sapi';
const LOCAL_SPEECH_STDIO_LIMIT = 4000;

const WINDOWS_SAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$text = [Environment]::GetEnvironmentVariable('CODEXMOBILE_SAPI_TEXT', 'Process')
$path = [Environment]::GetEnvironmentVariable('CODEXMOBILE_SAPI_PATH', 'Process')
$voice = [Environment]::GetEnvironmentVariable('CODEXMOBILE_SAPI_VOICE', 'Process')
if ([string]::IsNullOrWhiteSpace($text)) { throw 'No text to speak.' }
if ([string]::IsNullOrWhiteSpace($path)) { throw 'No output path.' }
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if (-not [string]::IsNullOrWhiteSpace($voice)) {
    $synth.SelectVoice($voice)
  }
  $synth.SetOutputToWaveFile($path)
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}
`;

const SPEECH_MIME_TYPES = new Map([
  ['mp3', 'audio/mpeg'],
  ['opus', 'audio/ogg'],
  ['aac', 'audio/aac'],
  ['flac', 'audio/flac'],
  ['wav', 'audio/wav'],
  ['pcm', 'audio/L16']
]);

function truthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function localSpeechFallbackEnabled() {
  return process.platform === 'win32' && !truthyEnv(process.env.CODEXMOBILE_SPEECH_DISABLE_LOCAL_FALLBACK);
}

function edgeSpeechEnabled() {
  return !truthyEnv(process.env.CODEXMOBILE_SPEECH_DISABLE_EDGE) &&
    !truthyEnv(process.env.CODEXMOBILE_TTS_DISABLE_EDGE);
}

function edgeSpeechVoice() {
  return process.env.CODEXMOBILE_SPEECH_EDGE_VOICE ||
    process.env.CODEXMOBILE_TTS_EDGE_VOICE ||
    DEFAULT_EDGE_SPEECH_VOICE;
}

function localSpeechVoice() {
  return process.env.CODEXMOBILE_SPEECH_LOCAL_VOICE ||
    process.env.CODEXMOBILE_TTS_LOCAL_VOICE ||
    '';
}

function safeProviderMessage(value) {
  return String(value || '语音合成失败')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/g, 'Bearer [hidden]')
    .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-[hidden]')
    .replace(/sk-\[hidden\][A-Za-z0-9*._-]*/g, 'sk-[hidden]')
    .slice(0, 500);
}

function parseErrorText(rawText, response) {
  try {
    const parsed = rawText ? JSON.parse(rawText) : null;
    return parsed?.error?.message || parsed?.error || parsed?.message || `语音合成接口返回 ${response.status}`;
  } catch {
    return rawText || `语音合成接口返回 ${response.status}`;
  }
}

function providerLabel(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.hostname === 'api.openai.com') {
      return 'openai';
    }
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    }
    return parsed.hostname || 'custom';
  } catch {
    return 'custom';
  }
}

function normalizeSpeechFormat(value) {
  const format = String(value || DEFAULT_SPEECH_FORMAT).trim().toLowerCase();
  return SPEECH_MIME_TYPES.has(format) ? format : DEFAULT_SPEECH_FORMAT;
}

function speechApiKeys() {
  return [
    process.env.CODEXMOBILE_SPEECH_API_KEY,
    process.env.CODEXMOBILE_TTS_API_KEY,
    process.env.OPENAI_API_KEY
  ].filter(Boolean);
}

async function voiceSpeechConfig(config = {}) {
  const baseUrl = process.env.CODEXMOBILE_SPEECH_BASE_URL ||
    process.env.CODEXMOBILE_TTS_BASE_URL ||
    config.baseUrl;
  const providerConfig = await openAICompatibleConfig({
    baseUrl,
    defaultBaseUrl: DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    apiKeys: speechApiKeys()
  });

  return {
    ...providerConfig,
    model: process.env.CODEXMOBILE_SPEECH_MODEL ||
      process.env.CODEXMOBILE_TTS_MODEL ||
      DEFAULT_SPEECH_MODEL,
    voice: process.env.CODEXMOBILE_SPEECH_VOICE ||
      process.env.CODEXMOBILE_TTS_VOICE ||
      DEFAULT_SPEECH_VOICE,
    format: normalizeSpeechFormat(
      process.env.CODEXMOBILE_SPEECH_FORMAT ||
      process.env.CODEXMOBILE_TTS_FORMAT ||
      DEFAULT_SPEECH_FORMAT
    ),
    instructions: process.env.CODEXMOBILE_SPEECH_INSTRUCTIONS ||
      process.env.CODEXMOBILE_TTS_INSTRUCTIONS ||
      ''
  };
}

export function speechMimeType(format) {
  return SPEECH_MIME_TYPES.get(normalizeSpeechFormat(format)) || SPEECH_MIME_TYPES.get(DEFAULT_SPEECH_FORMAT);
}

export function publicVoiceSpeechStatus(config = {}) {
  const baseUrl = process.env.CODEXMOBILE_SPEECH_BASE_URL ||
    process.env.CODEXMOBILE_TTS_BASE_URL ||
    config.baseUrl ||
    DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
  const localFallback = localSpeechFallbackEnabled();
  const edge = edgeSpeechEnabled();

  return {
    configured: !truthyEnv(process.env.CODEXMOBILE_SPEECH_DISABLED),
    provider: edge ? EDGE_SPEECH_PROVIDER : providerLabel(baseUrl),
    model: edge ? EDGE_SPEECH_FORMAT : process.env.CODEXMOBILE_SPEECH_MODEL ||
      process.env.CODEXMOBILE_TTS_MODEL ||
      DEFAULT_SPEECH_MODEL,
    voice: edge ? edgeSpeechVoice() : process.env.CODEXMOBILE_SPEECH_VOICE ||
      process.env.CODEXMOBILE_TTS_VOICE ||
      DEFAULT_SPEECH_VOICE,
    format: edge ? 'webm' : normalizeSpeechFormat(
      process.env.CODEXMOBILE_SPEECH_FORMAT ||
      process.env.CODEXMOBILE_TTS_FORMAT ||
      DEFAULT_SPEECH_FORMAT
    ),
    edge,
    edgeVoice: edge ? edgeSpeechVoice() : '',
    edgeFormat: edge ? EDGE_SPEECH_FORMAT : '',
    localFallback,
    localFallbackProvider: localFallback ? LOCAL_SPEECH_PROVIDER : ''
  };
}

async function requestSpeech({ text, config, apiKey }) {
  const headers = {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  };
  const body = {
    model: config.model,
    input: text,
    voice: config.voice,
    response_format: config.format
  };
  if (config.instructions) {
    body.instructions = config.instructions;
  }

  const response = await fetch(`${config.baseUrl}/audio/speech`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS)
  });

  if (!response.ok) {
    const rawText = await response.text();
    const error = new Error(safeProviderMessage(parseErrorText(rawText, response)));
    error.status = response.status;
    throw error;
  }

  return Buffer.from(await response.arrayBuffer());
}

function edgeConnectionId() {
  return randomUUID().replace(/-/g, '');
}

function edgeMuid() {
  return randomBytes(16).toString('hex').toUpperCase();
}

function edgeSecMsGec() {
  const windowsEpochSeconds = 11644473600n;
  let seconds = BigInt(Math.floor(Date.now() / 1000)) + windowsEpochSeconds;
  seconds -= seconds % 300n;
  const ticks = seconds * 10000000n;
  return createHash('sha256')
    .update(`${ticks}${EDGE_TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase();
}

function escapeSsml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function edgeProsodyAttribute(name, fallback) {
  const value = process.env[`CODEXMOBILE_SPEECH_EDGE_${name}`] ||
    process.env[`CODEXMOBILE_TTS_EDGE_${name}`] ||
    fallback;
  return String(value || fallback).trim();
}

function edgeSsml(text) {
  const voice = edgeSpeechVoice();
  const rate = edgeProsodyAttribute('RATE', '+0%');
  const pitch = edgeProsodyAttribute('PITCH', '+0Hz');
  const volume = edgeProsodyAttribute('VOLUME', '+0%');
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${escapeSsml(voice)}'><prosody pitch='${escapeSsml(pitch)}' rate='${escapeSsml(rate)}' volume='${escapeSsml(volume)}'>${escapeSsml(text)}</prosody></voice></speak>`;
}

function edgeMessage(path, contentType, body, extraHeaders = {}) {
  const headers = {
    ...extraHeaders,
    'X-Timestamp': new Date().toISOString(),
    'Content-Type': contentType,
    Path: path
  };
  const lines = Object.entries(headers).map(([key, value]) => `${key}:${value}`);
  return `${lines.join('\r\n')}\r\n\r\n${body}`;
}

function edgeAudioPayload(buffer) {
  if (buffer.length < 2) {
    return null;
  }
  const headerLength = buffer.readUInt16BE(0);
  if (headerLength + 2 > buffer.length) {
    return null;
  }
  const header = buffer.subarray(2, headerLength + 2).toString('utf8');
  if (!/\bPath:audio\b/i.test(header)) {
    return null;
  }
  const payload = buffer.subarray(headerLength + 2);
  return payload.length ? payload : null;
}

function requestEdgeSpeech(text) {
  return new Promise((resolve, reject) => {
    const connectionId = edgeConnectionId();
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TRUSTED_CLIENT_TOKEN}&ConnectionId=${connectionId}&Sec-MS-GEC=${edgeSecMsGec()}&Sec-MS-GEC-Version=${EDGE_GEC_VERSION}`;
    const chunks = [];
    let settled = false;
    const socket = new WebSocket(url, {
      perMessageDeflate: true,
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        Cookie: `muid=${edgeMuid()};`
      }
    });

    let timer = null;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      socket.close();
      if (error) {
        reject(error);
        return;
      }
      const data = Buffer.concat(chunks);
      if (!data.length) {
        const emptyError = new Error('Edge speech synthesis produced no audio.');
        emptyError.statusCode = 502;
        reject(emptyError);
        return;
      }
      resolve(data);
    };

    timer = setTimeout(() => {
      const error = new Error('Edge speech synthesis timed out.');
      error.statusCode = 504;
      finish(error);
    }, EDGE_SPEECH_TIMEOUT_MS);

    socket.on('open', () => {
      const speechConfig = {
        context: {
          synthesis: {
            audio: {
              metadataoptions: {
                sentenceBoundaryEnabled: false,
                wordBoundaryEnabled: false
              },
              outputFormat: EDGE_SPEECH_FORMAT
            }
          }
        }
      };
      socket.send(edgeMessage('speech.config', 'application/json; charset=utf-8', JSON.stringify(speechConfig)));
      socket.send(edgeMessage('ssml', 'application/ssml+xml', edgeSsml(text), {
        'X-RequestId': edgeConnectionId()
      }));
    });

    socket.on('message', (data, isBinary) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!isBinary) {
        const message = buffer.toString('utf8');
        if (/\bPath:turn\.end\b/i.test(message)) {
          finish();
        }
        return;
      }
      const payload = edgeAudioPayload(buffer);
      if (payload) {
        chunks.push(payload);
      }
    });
    socket.on('error', (error) => {
      error.statusCode ||= 502;
      finish(error);
    });
  });
}

async function synthesizeEdgeSpeech(text) {
  const data = await requestEdgeSpeech(text);
  return {
    data,
    mimeType: EDGE_SPEECH_MIME_TYPE,
    model: EDGE_SPEECH_FORMAT,
    voice: edgeSpeechVoice(),
    provider: EDGE_SPEECH_PROVIDER
  };
}

function runWindowsSapi({ text, outputPath }) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_SAPI_SCRIPT
    ], {
      env: {
        ...process.env,
        CODEXMOBILE_SAPI_TEXT: text,
        CODEXMOBILE_SAPI_PATH: outputPath,
        CODEXMOBILE_SAPI_VOICE: localSpeechVoice()
      },
      windowsHide: true
    });

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    const append = (current, chunk) => String(current + chunk).slice(-LOCAL_SPEECH_STDIO_LIMIT);
    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });

    timer = setTimeout(() => {
      const error = new Error('Local speech synthesis timed out.');
      error.statusCode = 504;
      child.kill();
      finish(error);
    }, LOCAL_SPEECH_TIMEOUT_MS);

    child.on('error', (error) => {
      finish(error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = safeProviderMessage(stderr || stdout || `PowerShell exited with code ${code}`);
      const error = new Error(`Local speech synthesis failed: ${detail}`);
      error.statusCode = 502;
      finish(error);
    });
  });
}

async function synthesizeLocalSpeech(text) {
  const outputPath = path.join(
    os.tmpdir(),
    `codexmobile-speech-${process.pid}-${Date.now()}-${randomUUID()}.wav`
  );

  try {
    await runWindowsSapi({ text, outputPath });
    const data = await fs.readFile(outputPath);
    if (!data.length) {
      const error = new Error('Local speech synthesis produced no audio.');
      error.statusCode = 502;
      throw error;
    }
    return {
      data,
      mimeType: 'audio/wav',
      model: LOCAL_SPEECH_PROVIDER,
      voice: localSpeechVoice() || 'system',
      provider: LOCAL_SPEECH_PROVIDER
    };
  } finally {
    await fs.unlink(outputPath).catch(() => null);
  }
}

export async function synthesizeSpeech(input, codexConfig = {}) {
  if (truthyEnv(process.env.CODEXMOBILE_SPEECH_DISABLED)) {
    const error = new Error('语音合成已禁用');
    error.statusCode = 503;
    throw error;
  }

  const text = String(input || '').replace(/\s+/g, ' ').trim().slice(0, SPEECH_MAX_INPUT_CHARS);
  if (!text) {
    const error = new Error('没有可朗读的文字');
    error.statusCode = 400;
    throw error;
  }

  if (edgeSpeechEnabled()) {
    try {
      return await synthesizeEdgeSpeech(text);
    } catch (error) {
      console.warn(`[voice] Edge speech failed, falling back: ${safeProviderMessage(error?.message || '')}`);
    }
  }

  const config = await voiceSpeechConfig(codexConfig);
  const apiKeys = config.apiKeys.length ? config.apiKeys : [''];
  let lastError = null;

  for (let index = 0; index < apiKeys.length; index += 1) {
    try {
      const data = await requestSpeech({ text, config, apiKey: apiKeys[index] });
      return {
        data,
        mimeType: speechMimeType(config.format),
        model: config.model,
        voice: config.voice,
        provider: providerLabel(config.baseUrl)
      };
    } catch (error) {
      lastError = error;
      const invalidKey = error.status === 401 ||
        /invalid api key|incorrect api key|unauthorized/i.test(error.message || '');
      if (invalidKey && index < apiKeys.length - 1) {
        console.warn(`[voice] speech API key #${index + 1} failed, trying next key.`);
        continue;
      }
      break;
    }
  }

  if (localSpeechFallbackEnabled()) {
    console.warn(`[voice] speech provider failed, using ${LOCAL_SPEECH_PROVIDER} fallback: ${safeProviderMessage(lastError?.message || '')}`);
    try {
      return await synthesizeLocalSpeech(text);
    } catch (fallbackError) {
      lastError = fallbackError;
    }
  }

  const finalError = new Error(safeProviderMessage(lastError?.message || '语音合成失败'));
  finalError.statusCode = lastError?.statusCode || lastError?.status || 502;
  throw finalError;
}
