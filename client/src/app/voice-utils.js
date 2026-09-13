// Pure helpers + constants for the voice-dialog and realtime-voice flows.
// All functions here are stateless / side-effect-free — extracted from
// App.jsx top-level as Stage 2 R9a so that the upcoming useVoiceRealtime
// (R9b) and useVoiceDialog (R9c) hooks can pull them in without
// duplicating either the logic or the regex tables.

// Realtime PCM stream tuning (matches the server-side dashscope proxy):
// 24 kHz mono → 2048-sample chunks. Barge-in (user starts speaking while
// the assistant is still talking) fires when the input level stays above
// the threshold for at least the sustain window.
export const REALTIME_VOICE_SAMPLE_RATE = 24000;
export const REALTIME_VOICE_BUFFER_SIZE = 2048;
export const REALTIME_VOICE_MIN_TURN_MS = 500;
export const REALTIME_VOICE_BARGE_IN_LEVEL_THRESHOLD = 0.026;
export const REALTIME_VOICE_BARGE_IN_SUSTAIN_MS = 180;

// Voice-dialog VAD tuning — used by useVoiceDialog's silence-detection
// loop and one-shot silence audio nudge. Previously declared as module-
// local consts in App.jsx (and referenced from useVoiceDialog by relying
// on bundler hoisting, which would have broken any time the consts left
// App.jsx); centralised here so the hook can import them explicitly.
export const VOICE_DIALOG_SILENCE_MS = 900;
export const VOICE_DIALOG_MIN_RECORDING_MS = 600;
export const VOICE_DIALOG_LEVEL_THRESHOLD = 0.018;
export const VOICE_DIALOG_SILENCE_AUDIO =
  'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';

export function realtimePayloadErrorMessage(payload) {
  return String(payload?.error?.message || payload?.error || payload?.message || '');
}

// Suppresses a dashscope quirk: it sends a "Conversation has none active
// response" error when we try to cancel an already-finished turn. Treating
// it as a hard error would spam the UI with red badges.
export function isBenignRealtimeCancelError(payload) {
  return /Conversation has none active response/i.test(realtimePayloadErrorMessage(payload));
}

// Strip whitespace + Chinese/English punctuation so the voice-command
// pattern matchers below can hit just on the words a user said.
export function normalizeVoiceCommandText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s，。！？、,.!?;；:："'“”‘’（）()【】\[\]<>《》]/g, '');
}

// True when the user's voice turn reads as "summarize what we discussed
// and send it to codex" rather than a normal continuation of the dialog.
// Used by the realtime handler to decide whether to suspend the realtime
// turn and hand the transcript off to the codex submission flow instead.
export function isVoiceHandoffCommand(value) {
  const text = normalizeVoiceCommandText(value);
  if (!text) {
    return false;
  }
  const wantsSummary = /总结|整理|归纳|汇总|梳理|提炼|概括|组织|形成任务|变成任务|整理成任务/.test(text);
  const wantsHandoff = /交给|发给|发送给|提交给|提交|让|叫|拿给|丢给|转给|传给|给/.test(text);
  const wantsAction = /执行|处理|做|改|实现|修|查|跑|操作|落实|开始干/.test(text);
  const mentionsExecutor =
    /codex|code[x叉]?|代码|扣德克斯|扣得克斯|扣的克斯|扣得|扣德|科德克斯|科得克斯|寇德克斯|口德克斯|口得克斯|助手|后台|你/.test(text);
  if (mentionsExecutor && ((wantsSummary && wantsHandoff) || (wantsSummary && wantsAction) || (wantsHandoff && wantsAction))) {
    return true;
  }
  if (wantsSummary && wantsHandoff) {
    return true;
  }
  if (/交给codex|发给codex|提交给codex|让codex|交给代码|发给代码|提交给代码|让代码/.test(text)) {
    return true;
  }
  return false;
}

// Reduce a markdown-flavored assistant reply to a flat string that's
// pleasant to read with TTS: drop image links / code fences / inline
// formatting markers, collapse whitespace, and cap at 2400 chars so a
// runaway reply doesn't lock up the speech pipeline.
export function spokenReplyText(value) {
  return String(value || '')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/```[\s\S]*?```/g, ' 代码块 ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[#>*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2400);
}

// Linear-interpolation resampler — Web Audio gives us whatever sample
// rate the hardware decides (often 44.1 / 48 kHz); dashscope wants
// REALTIME_VOICE_SAMPLE_RATE (24 kHz). No-ops when the rates already match.
export function downsampleAudio(input, inputRate, outputRate) {
  if (outputRate === inputRate) {
    return input;
  }
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const before = Math.floor(sourceIndex);
    const after = Math.min(before + 1, input.length - 1);
    const weight = sourceIndex - before;
    output[index] = input[before] * (1 - weight) + input[after] * weight;
  }
  return output;
}

// Float32 [-1, 1] PCM → little-endian 16-bit PCM → base64. The chunked
// String.fromCharCode loop is there because Chrome throws "Maximum call
// stack size exceeded" if you spread a Uint8Array longer than ~120k
// directly into fromCharCode.
export function floatToPcm16Base64(input) {
  const bytes = new Uint8Array(input.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

// Inverse of floatToPcm16Base64. Output Float32 is clamped to [-1, 1] for
// safety even though the source range should fit by construction.
export function pcm16Base64ToFloat(base64) {
  const binary = atob(base64);
  const length = Math.floor(binary.length / 2);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const lo = binary.charCodeAt(index * 2);
    const hi = binary.charCodeAt(index * 2 + 1);
    const value = (hi << 8) | lo;
    const signed = value >= 0x8000 ? value - 0x10000 : value;
    output[index] = Math.max(-1, Math.min(1, signed / 0x8000));
  }
  return output;
}

// RMS amplitude of a PCM chunk. Used to decide whether the user is
// actively talking (barge-in detection during assistant audio playback).
export function audioLevel(samples) {
  if (!samples?.length) {
    return 0;
  }
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) {
    total += samples[index] * samples[index];
  }
  return Math.sqrt(total / samples.length);
}
