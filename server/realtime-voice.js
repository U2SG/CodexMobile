import WebSocket from 'ws';

const OPENAI_REALTIME_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_CHEAPEST_REALTIME_MODEL = 'gpt-4o-mini-realtime-preview-2024-12-17';
const OPENAI_REALTIME_VOICE = 'alloy';
const VOLCENGINE_REALTIME_BASE_URL = 'https://ai-gateway.vei.volces.com/v1';
const VOLCENGINE_REALTIME_MODEL = 'AG-voice-chat-agent';
const VOLCENGINE_REALTIME_VOICE = 'zh_female_tianmeixiaoyuan_moon_bigtts';
const DASHSCOPE_REALTIME_BASE_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
const DASHSCOPE_REALTIME_MODEL = 'qwen3.5-omni-plus-realtime';
const DASHSCOPE_REALTIME_VOICE = 'Tina';
const PROVIDER_ALIASES = new Map([
  ['ali', 'dashscope'],
  ['aliyun', 'dashscope'],
  ['alibaba', 'dashscope'],
  ['bailian', 'dashscope'],
  ['dashscope', 'dashscope'],
  ['modelstudio', 'dashscope'],
  ['volc', 'volcengine'],
  ['volces', 'volcengine'],
  ['volcengine', 'volcengine'],
  ['ark', 'volcengine'],
  ['openai', 'openai'],
  ['openai-compatible', 'openai'],
  ['compatible', 'openai']
]);
const PROVIDER_DEFAULTS = {
  dashscope: {
    baseUrl: DASHSCOPE_REALTIME_BASE_URL,
    model: DASHSCOPE_REALTIME_MODEL,
    voice: DASHSCOPE_REALTIME_VOICE,
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    inputAudioFormat: 'pcm',
    outputAudioFormat: 'pcm',
    clientTurnDetection: true,
    cheapest: false,
    priceHint: '邀测免费/高智能'
  },
  volcengine: {
    baseUrl: VOLCENGINE_REALTIME_BASE_URL,
    model: VOLCENGINE_REALTIME_MODEL,
    voice: VOLCENGINE_REALTIME_VOICE,
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    inputAudioFormat: 'pcm16',
    outputAudioFormat: 'pcm16',
    clientTurnDetection: true,
    cheapest: true,
    priceHint: '火山免费额度'
  },
  openai: {
    baseUrl: OPENAI_REALTIME_BASE_URL,
    model: OPENAI_CHEAPEST_REALTIME_MODEL,
    voice: OPENAI_REALTIME_VOICE,
    inputSampleRate: 24000,
    outputSampleRate: 24000,
    inputAudioFormat: 'pcm16',
    outputAudioFormat: 'pcm16',
    clientTurnDetection: false,
    cheapest: true,
    priceHint: '最低价'
  }
};
const REALTIME_TIMEOUT_MS = Number(process.env.CODEXMOBILE_REALTIME_TIMEOUT_MS || 30000);
const REALTIME_VAD_SILENCE_MS = Number(process.env.CODEXMOBILE_REALTIME_VAD_SILENCE_MS || 650);
const REALTIME_VAD_THRESHOLD = Number(process.env.CODEXMOBILE_REALTIME_VAD_THRESHOLD || 0.5);
const CLIENT_VAD_SILENCE_MS = Number(process.env.CODEXMOBILE_REALTIME_CLIENT_VAD_SILENCE_MS || 900);
const REALTIME_TIME_ZONE = process.env.CODEXMOBILE_REALTIME_TIME_ZONE || 'Asia/Shanghai';

function truthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function safeMessage(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/g, 'Bearer [hidden]')
    .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-[hidden]')
    .replace(/sk-\[hidden\][A-Za-z0-9*._-]*/g, 'sk-[hidden]')
    .slice(0, 600);
}

function realtimeErrorMessage(event) {
  return safeMessage(event?.error?.message || event?.error || event?.message || '');
}

function isBenignRealtimeCancelError(event) {
  return /Conversation has none active response/i.test(realtimeErrorMessage(event));
}

function providerLabel(baseUrl, provider) {
  if (provider === 'dashscope') {
    return '阿里百炼';
  }
  if (provider === 'volcengine') {
    return '火山引擎';
  }
  try {
    const parsed = new URL(baseUrl);
    return parsed.hostname || 'custom';
  } catch {
    return 'custom';
  }
}

function normalizeProvider(value) {
  return PROVIDER_ALIASES.get(String(value || '').trim().toLowerCase()) || '';
}

function inferProviderFromBaseUrl(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    if (hostname.includes('dashscope.aliyuncs.com')) {
      return 'dashscope';
    }
    if (hostname.includes('volces.com') || hostname.includes('volcengine')) {
      return 'volcengine';
    }
  } catch {
    // Fall back below.
  }
  return '';
}

function realtimeProvider() {
  const explicit = normalizeProvider(process.env.CODEXMOBILE_REALTIME_PROVIDER);
  if (explicit) {
    return explicit;
  }

  const model = String(process.env.CODEXMOBILE_REALTIME_MODEL || process.env.CODEXMOBILE_VOICE_REALTIME_MODEL || '').trim();
  if (/^qwen/i.test(model)) {
    return 'dashscope';
  }
  if (/^ag-/i.test(model)) {
    return 'volcengine';
  }

  const baseUrl = process.env.CODEXMOBILE_REALTIME_BASE_URL || process.env.CODEXMOBILE_VOICE_REALTIME_BASE_URL || '';
  const inferred = inferProviderFromBaseUrl(baseUrl);
  if (inferred) {
    return inferred;
  }

  return baseUrl ? 'openai' : 'dashscope';
}

function realtimeDefaults() {
  return PROVIDER_DEFAULTS[realtimeProvider()] || PROVIDER_DEFAULTS.dashscope;
}

function realtimeBaseUrl() {
  const defaults = realtimeDefaults();
  return process.env.CODEXMOBILE_REALTIME_BASE_URL ||
    process.env.CODEXMOBILE_VOICE_REALTIME_BASE_URL ||
    defaults.baseUrl;
}

function realtimeModel() {
  const defaults = realtimeDefaults();
  return process.env.CODEXMOBILE_REALTIME_MODEL ||
    process.env.CODEXMOBILE_VOICE_REALTIME_MODEL ||
    defaults.model;
}

function realtimeApiKey() {
  const shared = process.env.CODEXMOBILE_REALTIME_API_KEY ||
    process.env.CODEXMOBILE_VOICE_REALTIME_API_KEY ||
    '';
  if (shared) {
    return shared;
  }
  if (realtimeProvider() === 'dashscope') {
    return process.env.CODEXMOBILE_DASHSCOPE_REALTIME_API_KEY ||
      process.env.CODEXMOBILE_DASHSCOPE_API_KEY ||
      process.env.DASHSCOPE_API_KEY ||
      '';
  }
  if (realtimeProvider() === 'volcengine') {
    return process.env.CODEXMOBILE_VOLCENGINE_REALTIME_API_KEY ||
      process.env.VOLCENGINE_API_KEY ||
      process.env.ARK_API_KEY ||
      '';
  }
  return process.env.OPENAI_API_KEY || '';
}

function realtimeVoice() {
  const defaults = realtimeDefaults();
  return process.env.CODEXMOBILE_REALTIME_VOICE ||
    process.env.CODEXMOBILE_VOICE_REALTIME_VOICE ||
    defaults.voice;
}

function realtimeInputSampleRate() {
  return Number(process.env.CODEXMOBILE_REALTIME_INPUT_SAMPLE_RATE) ||
    realtimeDefaults().inputSampleRate;
}

function realtimeOutputSampleRate() {
  return Number(process.env.CODEXMOBILE_REALTIME_OUTPUT_SAMPLE_RATE) ||
    realtimeDefaults().outputSampleRate;
}

function realtimeInputAudioFormat(provider = realtimeProvider()) {
  return process.env.CODEXMOBILE_REALTIME_INPUT_AUDIO_FORMAT ||
    PROVIDER_DEFAULTS[provider]?.inputAudioFormat ||
    'pcm16';
}

function realtimeOutputAudioFormat(provider = realtimeProvider()) {
  return process.env.CODEXMOBILE_REALTIME_OUTPUT_AUDIO_FORMAT ||
    PROVIDER_DEFAULTS[provider]?.outputAudioFormat ||
    'pcm16';
}

function realtimeInstructions() {
  const baseInstructions = process.env.CODEXMOBILE_REALTIME_INSTRUCTIONS ||
    '你是一个低延迟中文语音助手。回答要自然、简短、直接。';
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: REALTIME_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  return [
    baseInstructions,
    `当前日期时间：${formatter.format(now)}，时区：${REALTIME_TIME_ZONE}。`,
    '如果用户询问日期、时间、今天、明天、昨天，请优先使用这里给出的当前日期时间。',
    '如果用户说“总结/整理/汇总后交给 Codex/代码/助手执行”或类似意思，不要说你做不到；只需简短确认“我来整理”，系统会自动处理。'
  ].join('\n');
}

function realtimeSearchEnabled(provider) {
  return provider === 'dashscope' && truthyEnv(process.env.CODEXMOBILE_REALTIME_ENABLE_SEARCH);
}

function realtimeWebSocketUrl(baseUrl, model) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  let pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname || pathname === '/') {
    pathname = '/v1';
  }
  if (!pathname.endsWith('/v1') && !pathname.endsWith('/realtime')) {
    pathname = `${pathname}/v1`;
  }
  if (!pathname.endsWith('/realtime')) {
    pathname = `${pathname}/realtime`;
  }
  url.pathname = pathname;
  url.searchParams.set('model', model);
  return url.toString();
}

function realtimeHeaders(provider, apiKey) {
  const headers = {
    Authorization: `Bearer ${apiKey}`
  };
  if (provider === 'openai') {
    headers['OpenAI-Beta'] = 'realtime=v1';
  }
  return headers;
}

function realtimeSessionPayload(provider) {
  const session = {
    modalities: provider === 'volcengine' || provider === 'dashscope' ? ['text', 'audio'] : ['audio', 'text'],
    instructions: realtimeInstructions(),
    voice: realtimeVoice(),
    input_audio_format: realtimeInputAudioFormat(provider),
    output_audio_format: realtimeOutputAudioFormat(provider)
  };

  if (provider === 'dashscope') {
    session.turn_detection = null;
    session.smooth_output = true;
    if (realtimeSearchEnabled(provider)) {
      session.enable_search = true;
      session.search_options = {
        enable_source: true
      };
    }
  } else if (provider === 'volcengine') {
    session.output_audio_sample_rate = realtimeOutputSampleRate();
    session.input_audio_transcription = { model: 'any' };
    session.turn_detection = null;
  } else {
    session.turn_detection = {
      type: 'server_vad',
      threshold: REALTIME_VAD_THRESHOLD,
      prefix_padding_ms: 300,
      silence_duration_ms: REALTIME_VAD_SILENCE_MS
    };
  }

  return {
    type: 'session.update',
    session
  };
}

function realtimeResponseCreatePayload(provider) {
  return {
    type: 'response.create',
    response: {
      modalities: provider === 'volcengine' || provider === 'dashscope' ? ['text', 'audio'] : ['audio']
    }
  };
}

function normalizeHandoffTranscripts(value) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-30);
}

function realtimeHandoffPrompt(transcripts) {
  const spokenNotes = transcripts.map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    '你现在只做任务整理，不要回答用户问题。',
    '请把下面连续口语想法整理成一个可交给 Codex 执行的明确中文任务。',
    '只输出 JSON，不要 Markdown，不要解释。',
    'JSON 字段固定为：taskTitle、task、keyPoints、constraints。',
    'task 是一句明确可执行的任务；keyPoints 和 constraints 必须是字符串数组；没有约束时 constraints 为空数组。',
    '口语想法：',
    spokenNotes
  ].join('\n');
}

function realtimeHandoffResponseCreatePayload(provider, transcripts) {
  return {
    type: 'response.create',
    response: {
      modalities: ['text'],
      instructions: realtimeHandoffPrompt(transcripts)
    }
  };
}

function handoffEventText(event) {
  return String(
    event?.delta ||
      event?.text ||
      event?.transcript ||
      event?.part?.text ||
      event?.item?.content?.text ||
      ''
  );
}

function extractJsonObjectText(text) {
  const value = String(text || '').trim();
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : value;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return candidate.slice(start, end + 1);
  }
  return candidate;
}

function parseHandoffSummary(text) {
  try {
    const parsed = JSON.parse(extractJsonObjectText(text));
    return {
      taskTitle: String(parsed.taskTitle || '').trim(),
      task: String(parsed.task || '').trim(),
      keyPoints: Array.isArray(parsed.keyPoints)
        ? parsed.keyPoints.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
      constraints: Array.isArray(parsed.constraints)
        ? parsed.constraints.map((item) => String(item || '').trim()).filter(Boolean)
        : []
    };
  } catch {
    return null;
  }
}

function formatCodexHandoffMessage(summary, fallbackText) {
  if (!summary?.task) {
    return String(fallbackText || '').trim();
  }
  const lines = [
    '请执行下面任务：',
    '',
    '目标：',
    summary.task,
    '',
    '关键要点：'
  ];
  const keyPoints = summary.keyPoints.length ? summary.keyPoints : [summary.taskTitle || summary.task];
  for (const item of keyPoints) {
    lines.push(`- ${item}`);
  }
  lines.push('', '约束：');
  const constraints = summary.constraints.length ? summary.constraints : ['无额外约束'];
  for (const item of constraints) {
    lines.push(`- ${item}`);
  }
  return lines.join('\n').trim();
}

export function publicVoiceRealtimeStatus() {
  const disabled = truthyEnv(process.env.CODEXMOBILE_REALTIME_DISABLED) ||
    truthyEnv(process.env.CODEXMOBILE_VOICE_REALTIME_DISABLED);
  const apiKey = realtimeApiKey();
  const provider = realtimeProvider();
  const baseUrl = realtimeBaseUrl();
  const defaults = realtimeDefaults();

  return {
    configured: Boolean(!disabled && apiKey),
    disabled,
    provider: providerLabel(baseUrl, provider),
    providerId: provider,
    baseUrlConfigured: Boolean(process.env.CODEXMOBILE_REALTIME_BASE_URL || process.env.CODEXMOBILE_VOICE_REALTIME_BASE_URL),
    model: realtimeModel(),
    cheapest: defaults.cheapest,
    priceHint: defaults.priceHint,
    voice: realtimeVoice(),
    inputSampleRate: realtimeInputSampleRate(),
    outputSampleRate: realtimeOutputSampleRate(),
    inputAudioFormat: realtimeInputAudioFormat(provider),
    outputAudioFormat: realtimeOutputAudioFormat(provider),
    searchEnabled: realtimeSearchEnabled(provider),
    timeZone: REALTIME_TIME_ZONE,
    clientTurnDetection: defaults.clientTurnDetection,
    clientVadSilenceMs: CLIENT_VAD_SILENCE_MS,
    transport: 'server-websocket-proxy'
  };
}

export function startVoiceRealtimeProxy(client, { remoteAddress = '' } = {}) {
  const apiKey = realtimeApiKey();
  const status = publicVoiceRealtimeStatus();
  const provider = status.providerId || realtimeProvider();
  if (!status.configured) {
    client.send(JSON.stringify({
      type: 'voice.realtime.error',
      error: status.disabled ? '实时语音已禁用' : '未配置实时语音 API Key'
    }));
    client.close(1011, 'Realtime voice is not configured');
    return;
  }

  const upstreamUrl = realtimeWebSocketUrl(realtimeBaseUrl(), realtimeModel());
  const upstream = new WebSocket(upstreamUrl, {
    handshakeTimeout: REALTIME_TIMEOUT_MS,
    headers: realtimeHeaders(provider, apiKey)
  });
  const pending = [];
  let closed = false;
  let upstreamReady = false;
  let upstreamResponseActive = false;
  const handoff = {
    active: false,
    pendingTranscripts: null,
    text: ''
  };

  const sendClient = (payload) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  };

  const sendUpstream = (payload) => {
    const serialized = JSON.stringify(payload);
    if (upstream.readyState === WebSocket.OPEN && upstreamReady) {
      upstream.send(serialized);
      return;
    }
    pending.push(serialized);
  };

  const flushPending = () => {
    if (upstream.readyState !== WebSocket.OPEN || !upstreamReady) {
      return;
    }
    while (pending.length) {
      upstream.send(pending.shift());
    }
  };

  const closeBoth = () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      upstream.close();
    } catch {
      // Socket may already be gone.
    }
    try {
      client.close();
    } catch {
      // Socket may already be gone.
    }
  };

  const clearHandoff = () => {
    handoff.active = false;
    handoff.pendingTranscripts = null;
    handoff.text = '';
  };

  const sendHandoffError = (error) => {
    sendClient({
      type: 'voice.handoff.summary_error',
      error: safeMessage(error || '语音任务整理失败')
    });
    clearHandoff();
  };

  const beginHandoffSummary = (transcripts) => {
    const normalized = normalizeHandoffTranscripts(transcripts);
    if (!normalized.length) {
      sendHandoffError('还没有可整理的语音内容');
      return;
    }
    handoff.active = true;
    handoff.pendingTranscripts = null;
    handoff.text = '';
    sendClient({
      type: 'voice.handoff.summarizing',
      count: normalized.length
    });
    sendUpstream(realtimeHandoffResponseCreatePayload(provider, normalized));
    upstreamResponseActive = true;
  };

  const requestHandoffSummary = (transcripts) => {
    const normalized = normalizeHandoffTranscripts(transcripts);
    if (!normalized.length) {
      sendHandoffError('还没有可整理的语音内容');
      return;
    }
    handoff.pendingTranscripts = normalized;
    handoff.text = '';
    sendClient({
      type: 'voice.handoff.summarizing',
      count: normalized.length
    });
    if (upstreamResponseActive) {
      sendUpstream({ type: 'response.cancel' });
      return;
    }
    beginHandoffSummary(normalized);
  };

  const finishHandoffSummary = () => {
    const rawText = handoff.text.trim();
    const summary = parseHandoffSummary(rawText);
    sendClient({
      type: 'voice.handoff.summary_done',
      parsed: Boolean(summary),
      summary,
      rawText,
      message: formatCodexHandoffMessage(summary, rawText)
    });
    clearHandoff();
  };

  const handleHandoffEvent = (event) => {
    if (!handoff.active) {
      return false;
    }
    if (event.type === 'error') {
      sendHandoffError(realtimeErrorMessage(event));
      return true;
    }
    if (
      event.type === 'response.text.delta' ||
      event.type === 'response.output_text.delta' ||
      event.type === 'response.audio_transcript.delta' ||
      event.type === 'response.output_audio_transcript.delta' ||
      event.type === 'response.content_part.delta'
    ) {
      const delta = handoffEventText(event);
      if (delta) {
        handoff.text += delta;
        sendClient({
          type: 'voice.handoff.summary_delta',
          delta
        });
      }
      return true;
    }
    if (
      event.type === 'response.text.done' ||
      event.type === 'response.output_text.done' ||
      event.type === 'response.audio_transcript.done' ||
      event.type === 'response.output_audio_transcript.done' ||
      event.type === 'response.content_part.done' ||
      event.type === 'response.output_item.done'
    ) {
      const textPart = handoffEventText(event);
      if (textPart && !handoff.text.includes(textPart)) {
        handoff.text += textPart;
      }
      return true;
    }
    if (event.type === 'response.done') {
      upstreamResponseActive = false;
      finishHandoffSummary();
      return true;
    }
    return event.type?.startsWith?.('response.');
  };

  upstream.on('open', () => {
    upstream.send(JSON.stringify(realtimeSessionPayload(provider)));
    sendClient({
      type: 'voice.realtime.connecting',
      status
    });
  });

  upstream.on('message', (data) => {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    let event = null;
    try {
      event = JSON.parse(text);
    } catch {
      sendClient({ type: 'voice.realtime.raw', data: text });
      return;
    }

    if (event.type === 'session.updated') {
      upstreamReady = true;
      sendClient({
        type: 'voice.realtime.ready',
        status
      });
      flushPending();
    }

    if (event.type === 'response.created') {
      upstreamResponseActive = true;
    }
    if (event.type === 'error' && isBenignRealtimeCancelError(event)) {
      upstreamResponseActive = false;
      if (handoff.pendingTranscripts) {
        beginHandoffSummary(handoff.pendingTranscripts);
      } else {
        sendClient({ type: 'voice.realtime.cancel_ignored' });
      }
      return;
    }
    if (handleHandoffEvent(event)) {
      return;
    }
    if (event.type === 'response.done') {
      upstreamResponseActive = false;
      if (handoff.pendingTranscripts) {
        beginHandoffSummary(handoff.pendingTranscripts);
        return;
      }
    }
    if (event.type === 'error' && handoff.pendingTranscripts) {
      sendHandoffError(realtimeErrorMessage(event));
      return;
    }

    sendClient(event);
  });

  upstream.on('unexpected-response', (req, res) => {
    let body = '';
    res.on('data', (chunk) => {
      body += chunk.toString();
    });
    res.on('end', () => {
      console.warn(`[realtime] upstream rejected status=${res.statusCode} remote=${remoteAddress} body=${safeMessage(body)}`);
      sendClient({
        type: 'voice.realtime.error',
        error: safeMessage(body || `Realtime upstream rejected: ${res.statusCode}`)
      });
      closeBoth();
    });
  });

  upstream.on('error', (error) => {
    console.warn(`[realtime] upstream error remote=${remoteAddress} message=${safeMessage(error.message)}`);
    sendClient({
      type: 'voice.realtime.error',
      error: safeMessage(error.message || '实时语音连接失败')
    });
    closeBoth();
  });

  upstream.on('close', () => {
    sendClient({ type: 'voice.realtime.closed' });
    closeBoth();
  });

  client.on('message', (data) => {
    let payload = null;
    try {
      payload = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    } catch {
      return;
    }

    if (payload.type === 'input_audio.append' && typeof payload.audio === 'string') {
      sendUpstream({ type: 'input_audio_buffer.append', audio: payload.audio });
      return;
    }
    if (payload.type === 'input_audio.clear') {
      sendUpstream({ type: 'input_audio_buffer.clear' });
      return;
    }
    if (payload.type === 'input_audio.commit') {
      sendUpstream({ type: 'input_audio_buffer.commit' });
      sendUpstream(realtimeResponseCreatePayload(provider));
      upstreamResponseActive = true;
      return;
    }
    if (payload.type === 'response.cancel') {
      sendUpstream({ type: 'response.cancel' });
      return;
    }
    if (payload.type === 'voice.handoff.summarize') {
      requestHandoffSummary(payload.transcripts);
      return;
    }
    if (payload.type === 'close') {
      closeBoth();
    }
  });

  client.on('close', closeBoth);
  client.on('error', closeBoth);
}
