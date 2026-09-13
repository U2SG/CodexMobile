// useVoiceDialog — full voice-conversation panel + realtime audio dialog.
// Stage 2 R9b (combined R9b + R9c after the split-3 plan proved infeasible:
// realtime functions and dialog state are too intertwined to extract
// cleanly into separate hooks).
//
// Pure refactor from App.jsx — same 35 refs, 6 states, ~30 functions, and
// 2 useEffects, just moved verbatim into one place. Helpers and constants
// were pulled to voice-utils.js in R9a so the hook body imports them
// instead of relying on top-level closures in App.jsx.
//
// External dependencies (passed in via options):
//   status                — read for status.voiceTranscription /
//                          status.voiceRealtime / status.voiceSpeech config.
//   messages, runningById — read by the awaiting-turn effect that decides
//                          when to play back the codex reply via TTS.
//   selectedProject, selectedProjectRef — used by handoff submission to
//                          confirm we still have a target project.
//   submitCodexMessage    — from useTurnSubmission. Voice handoff submits
//                          its transcribed summary through the normal
//                          send flow.
//   handleVoiceSubmit     — from useTurnSubmission. Used when the user
//                          taps "send" on a non-realtime voice transcript
//                          (legacy single-shot mode).
//
// Returns the React-facing surface VoiceDialogPanel + Composer need:
//   state values: voiceDialogOpen / State / Error / Transcript /
//                 AssistantText / HandoffDraft
//   actions:      openVoiceDialog / closeVoiceDialog /
//                 startVoiceDialogRecording / stopVoiceDialogRecording /
//                 setVoiceDialogHandoffDraftValue /
//                 submitVoiceHandoffToCodex /
//                 continueVoiceHandoffCollection /
//                 cancelVoiceHandoffConfirmation

import { useEffect, useRef, useState } from 'react';

import {
  apiBlobFetch,
  apiFetch,
  realtimeVoiceWebsocketUrl
} from '../api.js';
import {
  REALTIME_VOICE_BARGE_IN_LEVEL_THRESHOLD,
  REALTIME_VOICE_BARGE_IN_SUSTAIN_MS,
  REALTIME_VOICE_BUFFER_SIZE,
  REALTIME_VOICE_MIN_TURN_MS,
  REALTIME_VOICE_SAMPLE_RATE,
  VOICE_DIALOG_LEVEL_THRESHOLD,
  VOICE_DIALOG_MIN_RECORDING_MS,
  VOICE_DIALOG_SILENCE_AUDIO,
  VOICE_DIALOG_SILENCE_MS,
  audioLevel,
  downsampleAudio,
  floatToPcm16Base64,
  isBenignRealtimeCancelError,
  isVoiceHandoffCommand,
  normalizeVoiceCommandText,
  pcm16Base64ToFloat,
  realtimePayloadErrorMessage,
  spokenReplyText
} from './voice-utils.js';

export function useVoiceDialog({
  status,
  messages,
  runningById,
  selectedProject,
  selectedProjectRef,
  submitCodexMessage,
  handleVoiceSubmit
}) {
  const voiceDialogRecorderRef = useRef(null);
  const voiceDialogChunksRef = useRef([]);
  const voiceDialogStreamRef = useRef(null);
  const voiceDialogTimerRef = useRef(null);
  const voiceDialogSilenceFrameRef = useRef(null);
  const voiceDialogAudioContextRef = useRef(null);
  const voiceDialogAudioSourceRef = useRef(null);
  const voiceDialogSpeechStartedRef = useRef(false);
  const voiceDialogLastSoundAtRef = useRef(0);
  const voiceDialogAudioRef = useRef(null);
  const voiceDialogAudioUnlockedRef = useRef(false);
  const voiceDialogAudioUrlRef = useRef('');
  const voiceDialogAwaitingTurnRef = useRef(null);
  const voiceDialogLastSpokenRef = useRef('');
  const voiceDialogAutoListenRef = useRef(false);
  const voiceDialogOpenRef = useRef(false);
  const voiceDialogStateRef = useRef('idle');
  const voiceDialogRealtimeRef = useRef(false);
  const voiceRealtimeSocketRef = useRef(null);
  const voiceRealtimeStreamRef = useRef(null);
  const voiceRealtimeAudioContextRef = useRef(null);
  const voiceRealtimeAudioSourceRef = useRef(null);
  const voiceRealtimeProcessorRef = useRef(null);
  const voiceRealtimePlaybackContextRef = useRef(null);
  const voiceRealtimePlaybackSourcesRef = useRef(new Set());
  const voiceRealtimePlayheadRef = useRef(0);
  const voiceRealtimeAssistantTextRef = useRef('');
  const voiceRealtimeSpeechStartedRef = useRef(false);
  const voiceRealtimeTurnStartedAtRef = useRef(0);
  const voiceRealtimeLastSoundAtRef = useRef(0);
  const voiceRealtimeAwaitingResponseRef = useRef(false);
  const voiceRealtimeBargeInStartedAtRef = useRef(0);
  const voiceRealtimeSuppressAssistantAudioRef = useRef(false);
  const voiceDialogIdeaBufferRef = useRef([]);
  const voiceDialogHandoffDraftRef = useRef('');

  const [voiceDialogOpen, setVoiceDialogOpen] = useState(false);
  const [voiceDialogState, setVoiceDialogState] = useState('idle');
  const [voiceDialogError, setVoiceDialogError] = useState('');
  const [voiceDialogTranscript, setVoiceDialogTranscript] = useState('');
  const [voiceDialogAssistantText, setVoiceDialogAssistantText] = useState('');
  const [voiceDialogHandoffDraft, setVoiceDialogHandoffDraft] = useState('');

  function setVoiceDialogMode(next) {
    voiceDialogStateRef.current = next;
    setVoiceDialogState(next);
  }

  function setVoiceDialogHandoffDraftValue(next) {
    const value = String(next || '');
    voiceDialogHandoffDraftRef.current = value;
    setVoiceDialogHandoffDraft(value);
  }

  function clearVoiceDialogTimer() {
    if (voiceDialogTimerRef.current) {
      window.clearTimeout(voiceDialogTimerRef.current);
      voiceDialogTimerRef.current = null;
    }
  }

  function clearVoiceDialogSilenceDetection() {
    if (voiceDialogSilenceFrameRef.current) {
      window.cancelAnimationFrame(voiceDialogSilenceFrameRef.current);
      voiceDialogSilenceFrameRef.current = null;
    }
    voiceDialogAudioSourceRef.current?.disconnect?.();
    voiceDialogAudioSourceRef.current = null;
    const context = voiceDialogAudioContextRef.current;
    voiceDialogAudioContextRef.current = null;
    if (context && context.state !== 'closed') {
      const closePromise = context.close?.();
      closePromise?.catch?.(() => null);
    }
    voiceDialogSpeechStartedRef.current = false;
    voiceDialogLastSoundAtRef.current = 0;
  }

  function stopVoiceDialogStream() {
    clearVoiceDialogSilenceDetection();
    voiceDialogStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    voiceDialogStreamRef.current = null;
  }

  function setupVoiceDialogSilenceDetection(stream, recorder) {
    clearVoiceDialogSilenceDetection();
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      return;
    }

    try {
      const context = new AudioContextCtor();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      voiceDialogAudioContextRef.current = context;
      voiceDialogAudioSourceRef.current = source;
      voiceDialogSpeechStartedRef.current = false;

      const samples = new Uint8Array(analyser.fftSize);
      const startedAt = performance.now();
      voiceDialogLastSoundAtRef.current = startedAt;

      const tick = (now) => {
        if (!voiceDialogOpenRef.current || recorder.state !== 'recording') {
          return;
        }

        analyser.getByteTimeDomainData(samples);
        let total = 0;
        for (let index = 0; index < samples.length; index += 1) {
          const value = (samples[index] - 128) / 128;
          total += value * value;
        }
        const level = Math.sqrt(total / samples.length);
        if (level >= VOICE_DIALOG_LEVEL_THRESHOLD) {
          voiceDialogSpeechStartedRef.current = true;
          voiceDialogLastSoundAtRef.current = now;
        }

        const heardSpeech = voiceDialogSpeechStartedRef.current;
        const recordingLongEnough = now - startedAt >= VOICE_DIALOG_MIN_RECORDING_MS;
        const silentLongEnough = now - voiceDialogLastSoundAtRef.current >= VOICE_DIALOG_SILENCE_MS;
        if (heardSpeech && recordingLongEnough && silentLongEnough) {
          setVoiceDialogMode('transcribing');
          recorder.stop();
          return;
        }

        voiceDialogSilenceFrameRef.current = window.requestAnimationFrame(tick);
      };

      const resumePromise = context.resume?.();
      resumePromise?.catch?.(() => null);
      voiceDialogSilenceFrameRef.current = window.requestAnimationFrame(tick);
    } catch {
      clearVoiceDialogSilenceDetection();
    }
  }

  function ensureVoiceDialogAudio() {
    if (!voiceDialogAudioRef.current) {
      const audio = new Audio();
      audio.preload = 'auto';
      audio.playsInline = true;
      voiceDialogAudioRef.current = audio;
    }
    return voiceDialogAudioRef.current;
  }

  function unlockVoiceDialogAudio() {
    if (voiceDialogAudioUnlockedRef.current) {
      return;
    }
    try {
      const audio = ensureVoiceDialogAudio();
      audio.muted = true;
      audio.src = VOICE_DIALOG_SILENCE_AUDIO;
      const playPromise = audio.play();
      playPromise
        ?.then?.(() => {
          audio.pause();
          audio.muted = false;
          audio.removeAttribute('src');
          audio.load?.();
          voiceDialogAudioUnlockedRef.current = true;
        })
        ?.catch?.(() => {
          audio.muted = false;
        });
    } catch {
      voiceDialogAudioUnlockedRef.current = false;
    }
  }

  function clearVoiceDialogAudio({ release = false } = {}) {
    const audio = voiceDialogAudioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load?.();
      if (release) {
        voiceDialogAudioRef.current = null;
        voiceDialogAudioUnlockedRef.current = false;
      }
    }
    if (voiceDialogAudioUrlRef.current) {
      URL.revokeObjectURL(voiceDialogAudioUrlRef.current);
      voiceDialogAudioUrlRef.current = '';
    }
    window.speechSynthesis?.cancel?.();
  }

  function stopRealtimePlayback({ release = false } = {}) {
    for (const source of voiceRealtimePlaybackSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    voiceRealtimePlaybackSourcesRef.current.clear();
    const context = voiceRealtimePlaybackContextRef.current;
    voiceRealtimePlayheadRef.current = context?.currentTime || 0;
    if (release && context && context.state !== 'closed') {
      context.close?.().catch?.(() => null);
      voiceRealtimePlaybackContextRef.current = null;
      voiceRealtimePlayheadRef.current = 0;
    }
  }

  function stopRealtimeVoiceDialog({ keepPanel = false } = {}) {
    const socket = voiceRealtimeSocketRef.current;
    voiceRealtimeSocketRef.current = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.send(JSON.stringify({ type: 'close' }));
      } catch {
        // Socket may already be closed.
      }
      try {
        socket.close();
      } catch {
        // Socket may already be closed.
      }
    }

    voiceRealtimeProcessorRef.current?.disconnect?.();
    voiceRealtimeProcessorRef.current = null;
    voiceRealtimeAudioSourceRef.current?.disconnect?.();
    voiceRealtimeAudioSourceRef.current = null;
    voiceRealtimeStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    voiceRealtimeStreamRef.current = null;
    const context = voiceRealtimeAudioContextRef.current;
    voiceRealtimeAudioContextRef.current = null;
    if (context && context.state !== 'closed') {
      context.close?.().catch?.(() => null);
    }
    voiceRealtimeAssistantTextRef.current = '';
    voiceRealtimeSpeechStartedRef.current = false;
    voiceRealtimeTurnStartedAtRef.current = 0;
    voiceRealtimeLastSoundAtRef.current = 0;
    voiceRealtimeAwaitingResponseRef.current = false;
    voiceRealtimeBargeInStartedAtRef.current = 0;
    voiceRealtimeSuppressAssistantAudioRef.current = false;
    stopRealtimePlayback({ release: true });
    if (!keepPanel) {
      voiceDialogRealtimeRef.current = false;
    }
  }

  function playRealtimeAudioDelta(delta) {
    if (!delta) {
      return;
    }
    const samples = pcm16Base64ToFloat(delta);
    if (!samples.length) {
      return;
    }
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      return;
    }
    let context = voiceRealtimePlaybackContextRef.current;
    if (!context || context.state === 'closed') {
      context = new AudioContextCtor();
      voiceRealtimePlaybackContextRef.current = context;
      voiceRealtimePlayheadRef.current = context.currentTime;
    }
    context.resume?.().catch?.(() => null);
    const outputSampleRate = Number(status.voiceRealtime?.outputSampleRate) || REALTIME_VOICE_SAMPLE_RATE;
    const buffer = context.createBuffer(1, samples.length, outputSampleRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    voiceRealtimePlaybackSourcesRef.current.add(source);
    source.onended = () => {
      voiceRealtimePlaybackSourcesRef.current.delete(source);
      if (
        voiceDialogOpenRef.current &&
        voiceDialogRealtimeRef.current &&
        voiceRealtimePlaybackSourcesRef.current.size === 0 &&
        voiceDialogStateRef.current === 'speaking'
      ) {
        voiceRealtimeAwaitingResponseRef.current = false;
        setVoiceDialogMode('listening');
      }
    };
    const startAt = Math.max(voiceRealtimePlayheadRef.current, context.currentTime + 0.03);
    source.start(startAt);
    voiceRealtimePlayheadRef.current = startAt + buffer.duration;
  }

  function appendVoiceDialogIdeaTranscript(transcript) {
    const text = String(transcript || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      return;
    }
    const buffer = voiceDialogIdeaBufferRef.current;
    if (buffer[buffer.length - 1] === text) {
      return;
    }
    buffer.push(text);
    if (buffer.length > 30) {
      buffer.splice(0, buffer.length - 30);
    }
  }

  function requestVoiceHandoffSummary(triggerText = '') {
    const socket = voiceRealtimeSocketRef.current;
    const transcripts = voiceDialogIdeaBufferRef.current.filter(Boolean);
    if (!transcripts.length) {
      setVoiceDialogErrorBriefly('还没有可整理的语音内容');
      return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setVoiceDialogErrorBriefly('实时语音连接不可用');
      return;
    }
    stopRealtimePlayback();
    voiceRealtimeSuppressAssistantAudioRef.current = true;
    voiceRealtimeAwaitingResponseRef.current = false;
    voiceRealtimeBargeInStartedAtRef.current = 0;
    voiceRealtimeAssistantTextRef.current = '';
    setVoiceDialogAssistantText('');
    setVoiceDialogHandoffDraftValue('');
    setVoiceDialogError('');
    setVoiceDialogMode('summarizing');
    socket.send(JSON.stringify({
      type: 'voice.handoff.summarize',
      transcripts,
      trigger: triggerText
    }));
  }

  async function startRealtimeMicrophone(socket) {
    if (!window.isSecureContext) {
      throw new Error('请使用 HTTPS 地址');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持录音');
    }
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error('当前浏览器不支持实时音频');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    const context = new AudioContextCtor();
    await context.resume?.().catch?.(() => null);
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(REALTIME_VOICE_BUFFER_SIZE, 1, 1);
    const inputSampleRate = Number(status.voiceRealtime?.inputSampleRate) || REALTIME_VOICE_SAMPLE_RATE;
    const useClientVad = Boolean(status.voiceRealtime?.clientTurnDetection);
    const silenceMs = Number(status.voiceRealtime?.clientVadSilenceMs) || VOICE_DIALOG_SILENCE_MS;
    const commitCurrentTurn = () => {
      if (!voiceRealtimeSpeechStartedRef.current || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      voiceRealtimeSpeechStartedRef.current = false;
      voiceRealtimeBargeInStartedAtRef.current = 0;
      voiceRealtimeAwaitingResponseRef.current = true;
      voiceRealtimeSuppressAssistantAudioRef.current = false;
      setVoiceDialogMode('waiting');
      socket.send(JSON.stringify({ type: 'input_audio.commit' }));
    };
    const beginBargeIn = () => {
      voiceRealtimeSuppressAssistantAudioRef.current = true;
      socket.send(JSON.stringify({ type: 'response.cancel' }));
      socket.send(JSON.stringify({ type: 'input_audio.clear' }));
      stopRealtimePlayback();
      voiceRealtimeAwaitingResponseRef.current = false;
      voiceRealtimeBargeInStartedAtRef.current = 0;
      voiceRealtimeAssistantTextRef.current = '';
      setVoiceDialogAssistantText('');
      setVoiceDialogMode('listening');
    };
    processor.onaudioprocess = (event) => {
      const output = event.outputBuffer.getChannelData(0);
      output.fill(0);
      if (
        !voiceDialogOpenRef.current ||
        !voiceDialogRealtimeRef.current ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      if (voiceDialogStateRef.current === 'summarizing' || voiceDialogStateRef.current === 'handoff') {
        return;
      }
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleAudio(input, context.sampleRate, inputSampleRate);
      if (!useClientVad) {
        socket.send(JSON.stringify({
          type: 'input_audio.append',
          audio: floatToPcm16Base64(downsampled)
        }));
        return;
      }

      const now = performance.now();
      const level = audioLevel(downsampled);
      const hasSound = level >= VOICE_DIALOG_LEVEL_THRESHOLD;
      if (voiceRealtimeAwaitingResponseRef.current) {
        const playbackActive =
          voiceRealtimePlaybackSourcesRef.current.size > 0 ||
          voiceDialogStateRef.current === 'speaking';
        if (playbackActive) {
          const bargeInCandidate = level >= REALTIME_VOICE_BARGE_IN_LEVEL_THRESHOLD;
          if (!bargeInCandidate) {
            voiceRealtimeBargeInStartedAtRef.current = 0;
            return;
          }
          if (!voiceRealtimeBargeInStartedAtRef.current) {
            voiceRealtimeBargeInStartedAtRef.current = now;
            return;
          }
          if (now - voiceRealtimeBargeInStartedAtRef.current < REALTIME_VOICE_BARGE_IN_SUSTAIN_MS) {
            return;
          }
          beginBargeIn();
        } else if (hasSound) {
          beginBargeIn();
        } else {
          voiceRealtimeBargeInStartedAtRef.current = 0;
          return;
        }
      }

      if (hasSound) {
        if (!voiceRealtimeSpeechStartedRef.current) {
          voiceRealtimeSpeechStartedRef.current = true;
          voiceRealtimeTurnStartedAtRef.current = now;
          setVoiceDialogMode('listening');
        }
        voiceRealtimeLastSoundAtRef.current = now;
      }

      if (!voiceRealtimeSpeechStartedRef.current) {
        return;
      }

      socket.send(JSON.stringify({
        type: 'input_audio.append',
        audio: floatToPcm16Base64(downsampled)
      }));

      const turnLongEnough = now - voiceRealtimeTurnStartedAtRef.current >= REALTIME_VOICE_MIN_TURN_MS;
      const silentLongEnough = now - voiceRealtimeLastSoundAtRef.current >= silenceMs;
      if (turnLongEnough && silentLongEnough) {
        commitCurrentTurn();
      }
    };

    source.connect(processor);
    processor.connect(context.destination);
    voiceRealtimeStreamRef.current = stream;
    voiceRealtimeAudioContextRef.current = context;
    voiceRealtimeAudioSourceRef.current = source;
    voiceRealtimeProcessorRef.current = processor;
  }

  function handleRealtimeVoiceEvent(payload) {
    if (!voiceDialogOpenRef.current || !voiceDialogRealtimeRef.current) {
      return;
    }
    if (payload.type === 'voice.realtime.connecting') {
      setVoiceDialogMode('waiting');
      return;
    }
    if (payload.type === 'voice.realtime.ready') {
      const socket = voiceRealtimeSocketRef.current;
      if (!socket || voiceRealtimeStreamRef.current) {
        setVoiceDialogMode('listening');
        return;
      }
      startRealtimeMicrophone(socket)
        .then(() => {
          setVoiceDialogError('');
          setVoiceDialogMode('listening');
        })
        .catch((error) => {
          setVoiceDialogErrorBriefly(error.message || '实时语音启动失败');
          stopRealtimeVoiceDialog({ keepPanel: true });
        });
      return;
    }
    if (payload.type === 'voice.realtime.cancel_ignored') {
      voiceRealtimeAwaitingResponseRef.current = false;
      voiceRealtimeBargeInStartedAtRef.current = 0;
      setVoiceDialogError('');
      setVoiceDialogMode('listening');
      return;
    }
    if (payload.type === 'voice.handoff.summarizing') {
      stopRealtimePlayback();
      voiceRealtimeSuppressAssistantAudioRef.current = true;
      voiceRealtimeAssistantTextRef.current = '';
      setVoiceDialogAssistantText('');
      setVoiceDialogError('');
      setVoiceDialogMode('summarizing');
      return;
    }
    if (payload.type === 'voice.handoff.summary_delta') {
      return;
    }
    if (payload.type === 'voice.handoff.summary_done') {
      const draft = String(payload.message || payload.rawText || '').trim();
      if (!draft) {
        setVoiceDialogErrorBriefly('没有整理出可交给 Codex 的任务');
        return;
      }
      setVoiceDialogHandoffDraftValue(draft);
      setVoiceDialogAssistantText('');
      setVoiceDialogError(payload.parsed ? '' : '整理结果不是标准 JSON，已作为草稿保留');
      setVoiceDialogMode('handoff');
      return;
    }
    if (payload.type === 'voice.handoff.summary_error') {
      voiceRealtimeSuppressAssistantAudioRef.current = false;
      setVoiceDialogErrorBriefly(payload.error || '语音任务整理失败');
      return;
    }
    if (payload.type === 'response.created') {
      if (voiceDialogStateRef.current === 'summarizing' || voiceDialogStateRef.current === 'handoff') {
        return;
      }
      voiceRealtimeSuppressAssistantAudioRef.current = false;
      voiceRealtimeAwaitingResponseRef.current = true;
      return;
    }
    if (payload.type === 'voice.realtime.error' || payload.type === 'error') {
      if (isBenignRealtimeCancelError(payload)) {
        voiceRealtimeAwaitingResponseRef.current = false;
        voiceRealtimeBargeInStartedAtRef.current = 0;
        setVoiceDialogError('');
        setVoiceDialogMode('listening');
        return;
      }
      const message = payload.error?.message || payload.error || '实时语音连接失败';
      voiceRealtimeAwaitingResponseRef.current = false;
      setVoiceDialogErrorBriefly(message);
      stopRealtimeVoiceDialog({ keepPanel: true });
      return;
    }
    if (payload.type === 'input_audio_buffer.speech_started') {
      stopRealtimePlayback();
      voiceRealtimeAssistantTextRef.current = '';
      voiceRealtimeAwaitingResponseRef.current = false;
      setVoiceDialogAssistantText('');
      setVoiceDialogMode('listening');
      return;
    }
    if (payload.type === 'input_audio_buffer.speech_stopped') {
      setVoiceDialogMode('waiting');
      return;
    }
    if (
      payload.type === 'conversation.item.input_audio_transcription.completed' &&
      payload.transcript
    ) {
      const transcript = String(payload.transcript || '').trim();
      setVoiceDialogTranscript(transcript);
      if (isVoiceHandoffCommand(transcript)) {
        requestVoiceHandoffSummary(transcript);
        return;
      }
      appendVoiceDialogIdeaTranscript(transcript);
      return;
    }
    if (
      (payload.type === 'response.audio_transcript.delta' ||
        payload.type === 'response.output_audio_transcript.delta') &&
      payload.delta
    ) {
      if (voiceRealtimeSuppressAssistantAudioRef.current) {
        return;
      }
      voiceRealtimeAssistantTextRef.current += payload.delta;
      setVoiceDialogAssistantText(voiceRealtimeAssistantTextRef.current.trim());
      return;
    }
    if (
      (payload.type === 'response.audio.delta' ||
        payload.type === 'response.output_audio.delta') &&
      payload.delta
    ) {
      if (voiceRealtimeSuppressAssistantAudioRef.current) {
        return;
      }
      voiceRealtimeAwaitingResponseRef.current = true;
      setVoiceDialogMode('speaking');
      playRealtimeAudioDelta(payload.delta);
      return;
    }
    if (
      payload.type === 'response.done' &&
      voiceDialogStateRef.current !== 'summarizing' &&
      voiceDialogStateRef.current !== 'handoff' &&
      voiceRealtimePlaybackSourcesRef.current.size === 0
    ) {
      voiceRealtimeSuppressAssistantAudioRef.current = false;
      voiceRealtimeAwaitingResponseRef.current = false;
      setVoiceDialogMode('listening');
    }
  }

  function startRealtimeVoiceDialog() {
    if (!status.voiceRealtime?.configured) {
      setVoiceDialogErrorBriefly('未配置实时语音');
      return;
    }
    if (voiceRealtimeSocketRef.current) {
      return;
    }
    clearVoiceDialogAudio();
    stopRealtimeVoiceDialog({ keepPanel: true });
    voiceDialogRealtimeRef.current = true;
    voiceRealtimeAssistantTextRef.current = '';
    setVoiceDialogError('');
    setVoiceDialogTranscript('');
    setVoiceDialogAssistantText('');
    setVoiceDialogMode('waiting');

    const socket = new WebSocket(realtimeVoiceWebsocketUrl());
    voiceRealtimeSocketRef.current = socket;
    socket.onopen = () => {
      setVoiceDialogMode('waiting');
    };
    socket.onmessage = (event) => {
      try {
        handleRealtimeVoiceEvent(JSON.parse(event.data));
      } catch {
        // Ignore malformed proxy events.
      }
    };
    socket.onerror = () => {
      setVoiceDialogErrorBriefly('实时语音连接失败');
      stopRealtimeVoiceDialog({ keepPanel: true });
    };
    socket.onclose = () => {
      if (voiceDialogOpenRef.current && voiceDialogRealtimeRef.current) {
        stopRealtimeVoiceDialog({ keepPanel: true });
        setVoiceDialogMode('idle');
      }
    };
  }

  function voiceDialogMimeType() {
    if (!window.MediaRecorder?.isTypeSupported) {
      return '';
    }
    return VOICE_MIME_CANDIDATES.find((type) => window.MediaRecorder.isTypeSupported(type)) || '';
  }

  function setVoiceDialogErrorBriefly(message) {
    setVoiceDialogError(message);
    setVoiceDialogMode('error');
  }

  async function transcribeVoiceDialogBlob(blob) {
    if (!blob?.size) {
      throw new Error('没有录到声音');
    }
    if (blob.size > VOICE_MAX_UPLOAD_BYTES) {
      throw new Error('录音超过 10MB');
    }

    const formData = new FormData();
    const extension = blob.type.includes('mp4') ? 'm4a' : 'webm';
    formData.append('audio', blob, `voice-dialog.${extension}`);
    const result = await apiFetch('/api/voice/transcribe', {
      method: 'POST',
      body: formData
    });
    const text = String(result.text || '').trim();
    if (!text) {
      throw new Error('没有识别到文字');
    }
    return text;
  }

  function playAudioBlob(blob) {
    return new Promise((resolve, reject) => {
      clearVoiceDialogAudio();
      const url = URL.createObjectURL(blob);
      const audio = ensureVoiceDialogAudio();
      voiceDialogAudioUrlRef.current = url;
      audio.muted = false;
      audio.src = url;
      audio.playsInline = true;
      audio.onended = () => {
        voiceDialogAudioUnlockedRef.current = true;
        resolve();
      };
      audio.onerror = () => reject(new Error('播放失败'));
      audio.load?.();
      audio.play().catch(reject);
    });
  }

  function speakWithBrowser(text) {
    return new Promise((resolve, reject) => {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
        reject(new Error('当前浏览器不支持朗读'));
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.onend = resolve;
      utterance.onerror = () => reject(new Error('朗读失败'));
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    });
  }

  function scheduleNextVoiceDialogTurn() {
    if (!voiceDialogOpenRef.current || !voiceDialogAutoListenRef.current) {
      setVoiceDialogMode('idle');
      return;
    }
    setVoiceDialogMode('idle');
    window.setTimeout(() => {
      if (voiceDialogOpenRef.current && voiceDialogAutoListenRef.current) {
        startVoiceDialogRecording();
      }
    }, 220);
  }

  async function playVoiceDialogReply(message) {
    const text = spokenReplyText(message?.content);
    if (!text) {
      scheduleNextVoiceDialogTurn();
      return;
    }

    setVoiceDialogAssistantText(text);
    setVoiceDialogError('');
    setVoiceDialogMode('speaking');

    try {
      const blob = await apiBlobFetch('/api/voice/speech', {
        method: 'POST',
        body: { text }
      });
      await playAudioBlob(blob);
    } catch (error) {
      try {
        await speakWithBrowser(text);
      } catch {
        setVoiceDialogError(error.message || '朗读失败');
      }
    } finally {
      clearVoiceDialogAudio();
      scheduleNextVoiceDialogTurn();
    }
  }

  async function startVoiceDialogRecording() {
    if (voiceDialogRealtimeRef.current) {
      startRealtimeVoiceDialog();
      return;
    }
    if (!voiceDialogOpenRef.current) {
      return;
    }
    if (['transcribing', 'sending', 'waiting', 'speaking'].includes(voiceDialogStateRef.current)) {
      return;
    }
    clearVoiceDialogTimer();
    clearVoiceDialogAudio();
    unlockVoiceDialogAudio();
    setVoiceDialogError('');
    setVoiceDialogTranscript('');
    setVoiceDialogAssistantText('');

    if (!selectedProjectRef.current && !selectedProject) {
      setVoiceDialogErrorBriefly('请先选择项目');
      return;
    }
    if (!window.isSecureContext) {
      setVoiceDialogErrorBriefly('请使用 HTTPS 地址');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setVoiceDialogErrorBriefly('当前浏览器不支持录音');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = voiceDialogMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      voiceDialogStreamRef.current = stream;
      voiceDialogChunksRef.current = [];
      voiceDialogRecorderRef.current = recorder;
      setupVoiceDialogSilenceDetection(stream, recorder);

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          voiceDialogChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        clearVoiceDialogTimer();
        stopVoiceDialogStream();
        voiceDialogRecorderRef.current = null;
        setVoiceDialogErrorBriefly('录音失败');
      };
      recorder.onstop = async () => {
        clearVoiceDialogTimer();
        stopVoiceDialogStream();
        const recordedType = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(voiceDialogChunksRef.current, { type: recordedType });
        voiceDialogChunksRef.current = [];
        voiceDialogRecorderRef.current = null;

        try {
          setVoiceDialogMode('transcribing');
          const transcript = await transcribeVoiceDialogBlob(blob);
          setVoiceDialogTranscript(transcript);
          setVoiceDialogMode('sending');
          const turn = await handleVoiceSubmit(transcript);
          voiceDialogAwaitingTurnRef.current = {
            turnId: turn?.turnId,
            message: transcript,
            startedAt: Date.now()
          };
          setVoiceDialogMode('waiting');
        } catch (error) {
          voiceDialogAwaitingTurnRef.current = null;
          setVoiceDialogErrorBriefly(error.message || '语音对话失败');
        }
      };

      recorder.start();
      setVoiceDialogMode('listening');
      voiceDialogTimerRef.current = window.setTimeout(() => {
        if (voiceDialogRecorderRef.current?.state === 'recording') {
          setVoiceDialogMode('transcribing');
          voiceDialogRecorderRef.current.stop();
        }
      }, VOICE_MAX_RECORDING_MS);
    } catch (error) {
      clearVoiceDialogTimer();
      stopVoiceDialogStream();
      voiceDialogRecorderRef.current = null;
      const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
      setVoiceDialogErrorBriefly(denied ? '麦克风权限被拒绝' : '录音启动失败');
    }
  }

  function stopVoiceDialogRecording() {
    if (voiceDialogRealtimeRef.current) {
      stopRealtimeVoiceDialog({ keepPanel: true });
      setVoiceDialogMode('idle');
      return;
    }
    if (voiceDialogRecorderRef.current?.state === 'recording') {
      setVoiceDialogError('');
      setVoiceDialogMode('transcribing');
      voiceDialogRecorderRef.current.stop();
      return;
    }
    clearVoiceDialogTimer();
    stopVoiceDialogStream();
    setVoiceDialogMode('idle');
  }

  function continueVoiceHandoffCollection() {
    setVoiceDialogHandoffDraftValue('');
    setVoiceDialogError('');
    setVoiceDialogAssistantText('');
    voiceRealtimeSuppressAssistantAudioRef.current = false;
    setVoiceDialogMode('listening');
  }

  function cancelVoiceHandoffConfirmation() {
    setVoiceDialogHandoffDraftValue('');
    setVoiceDialogError('');
    voiceRealtimeSuppressAssistantAudioRef.current = false;
    setVoiceDialogMode('listening');
  }

  async function submitVoiceHandoffToCodex() {
    const message = voiceDialogHandoffDraftRef.current.trim();
    if (!message) {
      return;
    }
    if (!selectedProjectRef.current && !selectedProject) {
      setVoiceDialogError('请先选择项目');
      setVoiceDialogMode('handoff');
      return;
    }
    try {
      setVoiceDialogError('');
      setVoiceDialogMode('sending');
      await submitCodexMessage({ message });
      voiceDialogIdeaBufferRef.current = [];
      setVoiceDialogHandoffDraftValue('');
      closeVoiceDialog();
    } catch (error) {
      setVoiceDialogError(error.message || '发送给 Codex 失败');
      setVoiceDialogMode('handoff');
    }
  }

  function openVoiceDialog() {
    unlockVoiceDialogAudio();
    voiceDialogOpenRef.current = true;
    voiceDialogRealtimeRef.current = Boolean(status.voiceRealtime?.configured);
    voiceDialogAutoListenRef.current = !voiceDialogRealtimeRef.current;
    voiceDialogAwaitingTurnRef.current = null;
    voiceDialogIdeaBufferRef.current = [];
    setVoiceDialogHandoffDraftValue('');
    setVoiceDialogOpen(true);
    setVoiceDialogError('');
    setVoiceDialogTranscript('');
    setVoiceDialogAssistantText('');
    setVoiceDialogMode('idle');
    window.setTimeout(() => {
      if (voiceDialogOpenRef.current) {
        if (voiceDialogRealtimeRef.current) {
          startRealtimeVoiceDialog();
        } else {
          startVoiceDialogRecording();
        }
      }
    }, 80);
  }

  function closeVoiceDialog() {
    voiceDialogAutoListenRef.current = false;
    voiceDialogOpenRef.current = false;
    voiceDialogAwaitingTurnRef.current = null;
    voiceDialogIdeaBufferRef.current = [];
    setVoiceDialogHandoffDraftValue('');
    stopRealtimeVoiceDialog();
    if (voiceDialogRecorderRef.current?.state === 'recording') {
      voiceDialogRecorderRef.current.onstop = null;
      voiceDialogRecorderRef.current.stop();
    }
    voiceDialogRecorderRef.current = null;
    clearVoiceDialogTimer();
    stopVoiceDialogStream();
    clearVoiceDialogAudio({ release: true });
    setVoiceDialogOpen(false);
    setVoiceDialogError('');
    setVoiceDialogTranscript('');
    setVoiceDialogAssistantText('');
    setVoiceDialogMode('idle');
  }

  useEffect(() => () => closeVoiceDialog(), []);

  useEffect(() => {
    const awaiting = voiceDialogAwaitingTurnRef.current;
    if (!voiceDialogOpen || !awaiting?.turnId || voiceDialogStateRef.current !== 'waiting') {
      return;
    }
    if (runningById[awaiting.turnId]) {
      return;
    }

    const reversed = [...messages].reverse();
    let reply = reversed.find(
      (message) =>
        message.role === 'assistant' &&
        message.turnId === awaiting.turnId &&
        String(message.content || '').trim()
    );

    if (!reply) {
      let userIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (
          message.role === 'user' &&
          (message.turnId === awaiting.turnId || String(message.content || '').trim() === awaiting.message)
        ) {
          userIndex = index;
          break;
        }
      }
      if (userIndex >= 0) {
        reply = [...messages.slice(userIndex + 1)].reverse().find(
          (message) => message.role === 'assistant' && String(message.content || '').trim()
        );
      }
    }

    const speechText = spokenReplyText(reply?.content);
    if (!reply || !speechText) {
      return;
    }

    const speechKey = `${awaiting.turnId}:${reply.id}:${speechText.length}`;
    if (voiceDialogLastSpokenRef.current === speechKey) {
      return;
    }
    voiceDialogLastSpokenRef.current = speechKey;
    voiceDialogAwaitingTurnRef.current = null;
    playVoiceDialogReply(reply);
  }, [messages, runningById, voiceDialogOpen]);

  return {
    voiceDialogOpen,
    voiceDialogState,
    voiceDialogError,
    voiceDialogTranscript,
    voiceDialogAssistantText,
    voiceDialogHandoffDraft,
    openVoiceDialog,
    closeVoiceDialog,
    startVoiceDialogRecording,
    stopVoiceDialogRecording,
    setVoiceDialogHandoffDraftValue,
    submitVoiceHandoffToCodex,
    continueVoiceHandoffCollection,
    cancelVoiceHandoffConfirmation
  };
}
