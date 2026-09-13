// Initial shape of the /api/status response. Used both by App body's
// state init and by PairingScreen's pre-paired status probe.
//
// No provider/model/modelShort baked in — these are agent-specific
// (claude server returns 'sonnet', codex server returns 'gpt-5.5' or
// similar) and a wrong placeholder leaks across routes during the brief
// pre-fetch render. Render paths already fall back to agent.providerLabel
// / '--' when these are null.

export const DEFAULT_STATUS = {
  connected: false,
  provider: null,
  model: null,
  modelShort: null,
  reasoningEffort: 'xhigh',
  models: [],
  voiceRealtime: { configured: false, model: 'qwen3.5-omni-plus-realtime', provider: '阿里百炼' },
  auth: { authenticated: false }
};
