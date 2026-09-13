import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  extractBearerToken,
  getPairingCode,
  getTrustedDeviceCount,
  initializeAuth,
  pairDevice,
  verifyToken
} from './auth.js';
import {
  deleteSession,
  getCacheSnapshot,
  findClaudeSessionJsonlPath,
  getHostName,
  getProject,
  getSession,
  hideSessionMessage,
  listProjectSessions,
  listProjects,
  listSessionsNeedingClaudeTitle,
  readSessionMessages,
  refreshCodexCache,
  renameSession
} from './codex-data.js';
import { getCodexQuota, switchCodexAccount } from './codex-quota.js';
import { abortCodexTurn, getActiveRuns as getCodexActiveRuns, runCodexTurn } from './codex-runner.js';
import { defaultProvider, defaultModel, defaultModelShort, isClaudeMode } from './agent-mode.js';
import { liveEnv } from './env-file.js';
import { agentCapabilities, currentAgentMatchesSession } from './agent-capabilities.js';
import { createFileRouteHandler } from './file-routes.js';
import { createStaticService } from './static-service.js';
import { saveUpload as uploadServiceSaveUpload } from './upload-service.js';
import {
  interruptDesktopFollowerTurn,
  startDesktopFollowerTurn,
  steerDesktopFollowerTurn
} from './desktop-ipc-client.js';
import { createBridgeStatusCache } from './desktop-bridge.js';
import { createDesktopThreadTracker } from './desktop-thread-tracker.js';
import { createDesktopTurnMonitor } from './desktop-turn-monitor.js';
import { createChatQueue } from './chat-queue.js';
import { createChatService } from './chat-service.js';
import { createRuntimePrefs, KNOWN_PREF_KEYS } from './runtime-prefs.js';
import { GENERATED_ROOT, analyzeImageIntent, isImageRequest, runImageTurn } from './image-generator.js';
import { getLarkDocsStatus, logoutLarkCli, startLarkCliAuth } from './lark-cli.js';
import { deleteMobileSessions, registerMobileSession, renameMobileSession } from './mobile-session-index.js';
import { openAICompatibleConfig } from './provider-api.js';
import { generateTitle } from './title-generator.js';
import { readClaudeTitleSource } from './claude-title-source.js';
import { createClaudeAutoTitler } from './claude-auto-titler.js';
import { createPinStore, listPinFolders } from './pinned-sessions.js';
import { createPinnedSessionsView } from './pinned-sessions-view.js';
import { createPinRoutes } from './pin-routes.js';
import { createChatRoutes } from './chat-routes.js';
import { createDesktopRoutes } from './desktop-routes.js';
import { createFeishuRoutes } from './feishu-routes.js';
import { createMetaRoutes } from './meta-routes.js';
import { createClaudeApprovalRoute } from './claude-approval-route.js';
import { getClaudeHookSecret } from './approval-pool.js';
import { getAvailableSkills } from './skill-discovery.js';
import { createQuotaRoutes } from './quota-routes.js';
import { createVoiceRoutes } from './voice-routes.js';
import { readVoiceUpload as readVoiceUploadFromService } from './upload-service.js';
import { createSessionRoutes } from './session-routes.js';
import { createPushService } from './push-service.js';
import { createPushRoutes } from './push-routes.js';
import { createPeerRoutes } from './peer-routes.js';
import { createSearchRoutes } from './search-routes.js';
import { createActivityRoutes } from './activity-routes.js';
import { createGitService } from './git-service.js';
import { createGitRoutes } from './git-routes.js';
import { createFileSessionIndexBundle } from './file-session-index-setup.js';
import { createFileSessionRoutes } from './file-session-routes.js';
import { hideProjectInMobile, readHiddenProjects, restoreProjectInMobile } from './session-local-state.js';
import { CODEX_SESSIONS_DIR } from './codex-config.js';
import { CLAUDE_PROJECTS_DIR } from './claude-config.js';
import { publicVoiceTranscriptionStatus, transcribeAudio } from './voice-transcriber.js';
import { listPendingApprovals } from './approval-pool.js';
import { publicVoiceSpeechStatus, synthesizeSpeech } from './voice-speaker.js';
import { publicVoiceRealtimeStatus, startVoiceRealtimeProxy } from './realtime-voice.js';
import { remoteAddress, sendJson } from './http-utils.js';

// Global safety net for AbortError leaks from cancelled turns.
//
// Aborting an in-flight turn (quota broadcast, user stop, idle timeout, …) can
// reject promises attached to the AbortSignal — most commonly a child-process
// "error" event listener or a `for await` over a streamed turn. If nothing is
// awaiting that promise at the moment of abort the rejection becomes an
// unhandledRejection, and Node 24's default policy terminates the process.
// Killed the :3333 server on 2026-05-08 23:11 when the upstream Codex quota
// hit zero. Swallow AbortError-class rejections; let everything else exit.
function isAbortLike(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return true;
  if (err.cause && isAbortLike(err.cause)) return true;
  return false;
}
process.on('unhandledRejection', (reason) => {
  if (isAbortLike(reason)) {
    console.warn('[abort] swallowed unhandled AbortError:', reason?.message || reason);
    return;
  }
  console.error('[fatal] unhandledRejection:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  if (isAbortLike(err)) {
    console.warn('[abort] swallowed uncaught AbortError:', err?.message || err);
    return;
  }
  console.error('[fatal] uncaughtException:', err);
  process.exit(1);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const CLIENT_DIST = path.join(ROOT_DIR, 'client', 'dist');
const UPLOAD_ROOT = path.join(ROOT_DIR, '.codexmobile', 'uploads');
const IMAGE_PROMPT_STATE = path.join(ROOT_DIR, '.codexmobile', 'state', 'image-prompts.json');
const FEISHU_AUTH_STATE = path.join(ROOT_DIR, '.codexmobile', 'state', 'feishu-auth.json');
const PORT = Number(process.env.PORT || 3321);
const HOST = process.env.HOST || '0.0.0.0';
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const HTTPS_PFX_PATH = process.env.HTTPS_PFX_PATH || path.join(ROOT_DIR, '.codexmobile', 'tls', 'server.pfx');
const HTTPS_ROOT_CA_PATH = process.env.HTTPS_ROOT_CA_PATH || path.join(ROOT_DIR, '.codexmobile', 'tls', 'codexmobile-root-ca.cer');
const HTTPS_PFX_PASSPHRASE = process.env.HTTPS_PFX_PASSPHRASE || 'codexmobile-local-https';
const PUBLIC_URL = process.env.CODEXMOBILE_PUBLIC_URL || '';
const FEISHU_APP_ID = String(process.env.CODEXMOBILE_FEISHU_APP_ID || '').trim();
const FEISHU_APP_SECRET = String(process.env.CODEXMOBILE_FEISHU_APP_SECRET || '').trim();
const FEISHU_REDIRECT_URI = String(process.env.CODEXMOBILE_FEISHU_REDIRECT_URI || '').trim();
const FEISHU_DOCS_HOME_URL = process.env.CODEXMOBILE_FEISHU_DOCS_URL || 'https://docs.feishu.cn/';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_REASONING_EFFORT = 'xhigh';
const FEISHU_AUTH_STATE_MAX_AGE_MS = 15 * 60 * 1000;

const pinStore = createPinStore();
const sockets = new Set();
const chatQueue = createChatQueue();
let chatService = null;
let chatRoutes = null;

const bridgeStatus = createBridgeStatusCache({});
const runtimePrefs = createRuntimePrefs({
  envDefaults: {
    ipcTurnsEnabled: process.env.CODEXMOBILE_USE_IPC_TURNS === '1'
  },
  rejectKey: (key, value) => {
    if (key === 'ipcTurnsEnabled' && Boolean(value) && isClaudeMode()) {
      return 'Claude 模式不支持桌面端 Codex IPC';
    }
    return null;
  }
});
const threadTracker = createDesktopThreadTracker({});
threadTracker.onChange((openIds) => {
  // Re-emit so connected clients re-render their live indicators promptly.
  broadcast({ type: 'desktop-threads', openThreadIds: [...openIds] });
});
threadTracker.onConnectionChange(() => {
  // Fires on every tracker connect/disconnect transition, including the
  // "desktop came back but no threads are open yet" case that onChange
  // would silently miss. This is the strongest near-real-time signal that
  // the bridge state may have changed; force a probe and let
  // bridgeStatus.onChange push the new status to PWAs without waiting
  // for the next 30s useDesktopBridge poll.
  bridgeStatus.getStatus({ force: true }).catch(() => null);
});
bridgeStatus.onChange((status) => {
  broadcast({
    type: 'desktop-bridge-changed',
    status: { ...status, openThreadIds: threadTracker.getOpenThreadIds() }
  });
});


threadTracker.onActivity(({ conversationId, change }) => {
  console.log(`[chat] IPC activity session=${conversationId} change.type=${change?.type || 'unknown'}`);
});

threadTracker.start().catch((error) => {
  console.warn('[thread-tracker] start failed:', error.message);
});

const desktopTurnMonitor = createDesktopTurnMonitor({
  readSessionMessages,
  refreshCodexCache,
  rememberTurn,
  broadcast
});

async function emitSyncComplete() {
  const snapshot = await refreshCodexCache();
  // Any fresh sessions are now durable on disk; invalidate the lazy file ↔
  // session index so the next /api/files/sessions request rescans rollouts
  // and picks up apply_patch entries from the newly-synced sessions.
  fileSessionIndex.invalidate();
  broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects, pinFolders: snapshot.pinFolders });
  // Backfill LLM titles for terminal-started Claude sessions (no-op outside
  // claude mode; debounced + self-draining).
  claudeAutoTitler.schedule();
}

// Title model is read live from .env (not the boot-frozen process.env) so a
// model swap takes effect on the next title run without a restart.
const titleModel = () => liveEnv('CODEXMOBILE_TITLE_MODEL');

// Gives terminal-started Claude sessions the same ≤14-char LLM titles that
// app-initiated ones get on first-turn completion. Runs only in claude mode.
const claudeAutoTitler = createClaudeAutoTitler({
  isEnabled: isClaudeMode,
  listCandidates: listSessionsNeedingClaudeTitle,
  readTitleSource: readClaudeTitleSource,
  generateTitle,
  getConfig: () => openAICompatibleConfig({}),
  renameTitle: ({ id, projectPath, title }) => renameMobileSession({ id, projectPath, title }),
  onTitled: async () => {
    const snapshot = await refreshCodexCache();
    broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects, pinFolders: snapshot.pinFolders });
  },
  model: titleModel,
  timeoutMs: Number(process.env.CODEXMOBILE_TITLE_TIMEOUT_MS) || 15000
});

function upgradeTitleInBackground({ sessionId, projectPath, messageText }) {
  if (!sessionId || !messageText) return;
  (async () => {
    try {
      const config = await openAICompatibleConfig({});
      const result = await generateTitle({
        messageText,
        baseUrl: config.baseUrl,
        apiKey: config.apiKeys,
        model: await titleModel(),
        timeoutMs: Number(process.env.CODEXMOBILE_TITLE_TIMEOUT_MS) || 6000
      });
      if (result.source !== 'model') {
        console.log(`[title-generator] skip session=${sessionId} reason=${result.reason}`);
        return;
      }
      await renameMobileSession({
        id: sessionId,
        projectPath,
        title: result.title,
        updatedAt: new Date().toISOString()
      });
      console.log(`[title-generator] upgraded session=${sessionId} title="${result.title}"`);
      await emitSyncComplete();
    } catch (error) {
      console.warn(`[title-generator] failed session=${sessionId}: ${error.message}`);
    }
  })();
}

async function maybeAutoNameSession({ session, userMessage, assistantMessage, renameSessionImpl = renameSession }) {
  if (!session || session.titleLocked) {
    return null;
  }
  const config = await openAICompatibleConfig({});
  const result = await generateTitle({
    messageText: [userMessage, assistantMessage].filter(Boolean).join('\n\n'),
    baseUrl: config.baseUrl,
    apiKey: config.apiKeys,
    model: await titleModel(),
    timeoutMs: Number(process.env.CODEXMOBILE_TITLE_TIMEOUT_MS) || 6000
  });
  if (result.source !== 'model') {
    return null;
  }
  return renameSessionImpl(session.id, session.projectId, result.title);
}

const pinRoutes = createPinRoutes({
  store: pinStore,
  getSession: (id) => getSession(id),
  onMutation: emitSyncComplete
});

const pushService = createPushService({
  stateDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.codexmobile', 'state'),
  ...(process.env.CODEXMOBILE_PUSH_SUBJECT ? { subject: process.env.CODEXMOBILE_PUSH_SUBJECT } : {})
});
const pushRoutes = createPushRoutes({ pushService });
const peerRoutes = createPeerRoutes({ peerUrlsRaw: process.env.CODEXMOBILE_PEER_URLS || '' });

// IMPORTANT — load-order rule:
//
// `const` values are NOT hoisted; they sit in the temporal dead zone until
// their declaration line runs. The file-session-index bundle below exposes
// three names (fileSessionIndex / listRolloutFilesFromBoth /
// classifyRolloutSource) that several route factories consume. Anything
// that references them MUST appear after this block. Use `npm run smoke:load`
// to catch regressions — it spawns node with a clean env and asserts that
// server/index.js evaluates without throwing.
const {
  fileSessionIndex,
  listRolloutFiles: listRolloutFilesFromBoth,
  readRolloutFile,
  classifySourceFile: classifyRolloutSource
} = createFileSessionIndexBundle({
  rootDir: ROOT_DIR,
  codexSessionsDir: CODEX_SESSIONS_DIR,
  claudeProjectsDir: CLAUDE_PROJECTS_DIR
});

const searchRoutes = createSearchRoutes({
  listRolloutFiles: listRolloutFilesFromBoth,
  readRolloutFile,
  classifySourceFile: classifyRolloutSource,
  getProject: (id) => getProject(id)
});

const gitService = createGitService({});
const gitRoutes = createGitRoutes({ gitService, getProject: (id) => getProject(id) });

const fileSessionRoutes = createFileSessionRoutes({
  fileSessionIndex,
  getProject: (id) => getProject(id)
});
const activityRoutes = createActivityRoutes({ fileSessionIndex });

const quotaRoutes = createQuotaRoutes({ getCodexQuota, switchCodexAccount, remoteAddress });

const voiceRoutes = createVoiceRoutes({
  transcribeAudio,
  synthesizeSpeech,
  readVoiceUpload: readVoiceUploadFromService,
  getCacheSnapshot,
  remoteAddress
});

const feishuRoutes = createFeishuRoutes({
  config: {
    appId: FEISHU_APP_ID,
    appSecret: FEISHU_APP_SECRET,
    redirectUriOverride: FEISHU_REDIRECT_URI,
    authStatePath: FEISHU_AUTH_STATE,
    authStateMaxAgeMs: FEISHU_AUTH_STATE_MAX_AGE_MS,
    docsHomeUrl: FEISHU_DOCS_HOME_URL,
    publicUrl: PUBLIC_URL
  },
  port: PORT,
  getLarkDocsStatus,
  startLarkCliAuth,
  logoutLarkCli,
  remoteAddress
});
const publicDocsStatus = feishuRoutes.publicDocsStatus;

const desktopRoutes = createDesktopRoutes({
  runtimePrefs,
  knownPrefKeys: KNOWN_PREF_KEYS,
  bridgeStatus,
  threadTracker
});

const REPO_SKILLS_DIR = path.join(ROOT_DIR, 'skills');
const listAvailableSkills = (options = {}) => getAvailableSkills({
  repoSkillsDir: REPO_SKILLS_DIR,
  agent: defaultProvider(),
  ...options
});

const buildPinnedSessionsResponse = createPinnedSessionsView({
  pinStore,
  getCacheSnapshot,
  getSession,
  getProject,
  filterSession: currentAgentMatchesSession
});

const claudeApprovalRoute = createClaudeApprovalRoute({ broadcast });

const metaRoutes = createMetaRoutes({
  publicStatus,
  isAuthenticated,
  pairDevice,
  refreshCodexCache,
  broadcast,
  listProjects,
  getProject,
  hideProject: hideProjectInMobile,
  restoreProject: restoreProjectInMobile,
  listArchivedProjects: readHiddenProjects,
  listPinFolders,
  buildPinnedSessionsResponse,
  listAvailableSkills,
  remoteAddress
});

const sessionRoutes = createSessionRoutes({
  listProjectSessions,
  getProject,
  getSession,
  renameSession,
  deleteSession,
  hideSessionMessage,
  readSessionMessages,
  sessionHasActiveWork: (id) => sessionHasActiveWork(id),
  onMutation: emitSyncComplete,
  onMessageDeleted: async (deleted) => {
    broadcast({ type: 'message-deleted', ...deleted });
  },
  filterSession: currentAgentMatchesSession
});

const staticService = createStaticService({
  clientDist: CLIENT_DIST,
  generatedRoot: GENERATED_ROOT,
  httpsRootCaPath: HTTPS_ROOT_CA_PATH
});

const fileRoutes = createFileRouteHandler({
  getProject,
  staticService,
  saveUpload: uploadServiceSaveUpload,
  uploadRoot: UPLOAD_ROOT,
  maxUploadBytes: MAX_UPLOAD_BYTES,
  remoteAddress
});

chatService = createChatService({
  imagePromptState: IMAGE_PROMPT_STATE,
  defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
  isDesktopThreadOpen: (id) => threadTracker.isThreadOpen(id),
  listAvailableSkills,
  listWorktrees: (repoPath) => gitService.worktrees(repoPath),
  getProject,
  getSession,
  getCacheSnapshot,
  getDesktopBridgeStatus: async (options) => {
    if (isClaudeMode()) {
      return {
        strict: false,
        connected: true,
        mode: 'headless-local',
        reason: 'Claude 模式不使用桌面端 Codex IPC',
        capabilities: { read: true, createThread: true, sendToOpenDesktopThread: false }
      };
    }
    const prefs = await runtimePrefs.getAll().catch(() => ({ ipcTurnsEnabled: false }));
    if (!prefs.ipcTurnsEnabled) {
      return {
        strict: false,
        connected: true,
        mode: 'headless-local',
        reason: '桌面端 IPC 未启用，正在使用后台 Codex 执行',
        capabilities: { read: true, createThread: true, sendToOpenDesktopThread: false }
      };
    }
    const status = await bridgeStatus.getStatus(options).catch((error) => ({
      connected: false,
      mode: 'desktop-ipc',
      reason: error.message
    }));
    return {
      ...status,
      strict: false,
      capabilities: {
        read: true,
        sendToOpenDesktopThread: true,
        createThread: false,
        backgroundCodex: true,
        createThreadViaBackground: true
      }
    };
  },
  listProjectSessions,
  readSessionMessages,
  refreshCodexCache,
  renameSession,
  broadcast,
  runCodexTurn,
  steerCodexTurn: async () => {
    const error = new Error('当前后台 Codex 运行不支持追加到进行中的任务。');
    error.statusCode = 409;
    throw error;
  },
  startDesktopFollowerTurn,
  steerDesktopFollowerTurn,
  interruptDesktopFollowerTurn,
  abortCodexTurn,
  getActiveRuns: getCodexActiveRuns,
  runImageTurn,
  isImageRequest,
  analyzeImageIntent,
  useLegacyImageGenerator: () => true,
  maybeAutoNameSession,
  registerMobileSession,
  unregisterMobileSessions: deleteMobileSessions,
  chatQueue
});

chatRoutes = createChatRoutes({
  chatService,
  steerDesktopFollowerTurn,
  findClaudeSessionJsonlPath,
  getAllActiveRuns: () => [
    ...getCodexActiveRuns(),
    ...desktopTurnMonitor.getActiveRuns(),
    ...(chatService?.getActiveDesktopIpcRuns?.() || []),
    ...getActiveImageRuns()
  ],
  broadcast,
  remoteAddress
});

function rememberTurn(turnId, patch) {
  return chatQueue.rememberTurn(turnId, patch);
}


function fallbackModels(config) {
  const model = config.model || defaultModel();
  return [{ value: model, label: model }];
}

function getActiveImageRuns() {
  return (chatService?.getActiveImageRuns?.() || []).map((run) => ({
    sessionId: run.sessionId,
    previousSessionId: run.previousSessionId,
    startedAt: run.startedAt,
    status: run.status,
    turnId: run.turnId,
    kind: 'image_generation_call',
    label: run.label
  }));
}

function payloadReferencesSession(payload, sessionId) {
  return [
    payload?.sessionId,
    payload?.previousSessionId,
    payload?.draftSessionId,
    payload?.selectedSessionId
  ].some((value) => value && value === sessionId);
}

function sessionHasActiveWork(sessionId) {
  if (!sessionId) {
    return false;
  }
  const activeRuns = [...getCodexActiveRuns(), ...desktopTurnMonitor.getActiveRuns(), ...getActiveImageRuns()];
  if (chatService?.sessionHasActiveWork?.(sessionId)) {
    return true;
  }
  return chatQueue.sessionHasActiveWork(sessionId, activeRuns);
}


async function isAuthenticated(req) {
  return verifyToken(extractBearerToken(req), { remoteAddress: remoteAddress(req) });
}

async function requireAuth(req, res, pathname = '') {
  if (await isAuthenticated(req)) {
    return true;
  }
  if ((req.method || 'GET') !== 'GET') {
    console.warn(`[auth] rejected ${req.method || 'GET'} ${pathname || req.url || ''} remote=${remoteAddress(req)}`);
  }
  sendJson(res, 401, { error: 'Pairing required' });
  return false;
}

function broadcast(payload) {
  const serialized = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(serialized);
    }
  }
}

// Build identity of the currently deployed PWA, derived from the Vite content
// hash in client/dist/index.html. The client compares this against the hash of
// its own running bundle to surface a "new version available" prompt — an
// installed iOS PWA otherwise keeps serving a stale build indefinitely.
let clientBuildIdCache = { mtimeMs: 0, value: null };
async function getClientBuildId() {
  try {
    const indexPath = path.join(CLIENT_DIST, 'index.html');
    const stat = await fs.stat(indexPath);
    if (stat.mtimeMs !== clientBuildIdCache.mtimeMs) {
      const html = await fs.readFile(indexPath, 'utf8');
      const match = html.match(/\/assets\/index-([\w-]+)\.js/);
      clientBuildIdCache = { mtimeMs: stat.mtimeMs, value: match ? match[1] : null };
    }
  } catch {
    clientBuildIdCache = { mtimeMs: 0, value: null };
  }
  return clientBuildIdCache.value;
}

function activeRunsSnapshot() {
  return [
    ...getCodexActiveRuns(),
    ...desktopTurnMonitor.getActiveRuns(),
    ...(chatService?.getActiveDesktopIpcRuns?.() || []),
    ...getActiveImageRuns()
  ];
}

async function publicStatus(authenticated) {
  const snapshot = getCacheSnapshot();
  const config = snapshot.config || {};
  return {
    connected: true,
    hostName: getHostName(),
    port: PORT,
    buildId: await getClientBuildId(),
    provider: config.provider || defaultProvider(),
    model: config.model || defaultModel(),
    resolvedModel: config.resolvedModel || null,
    modelShort: config.modelShort || defaultModelShort(),
    capabilities: agentCapabilities(config.provider || defaultProvider()),
    models: config.models?.length ? config.models : fallbackModels(config),
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    voiceTranscription: publicVoiceTranscriptionStatus(config),
    voiceSpeech: publicVoiceSpeechStatus(config),
    voiceRealtime: publicVoiceRealtimeStatus(config),
    docs: await publicDocsStatus(authenticated),
    syncedAt: snapshot.syncedAt,
    activeRuns: activeRunsSnapshot(),
    auth: {
      required: true,
      authenticated,
      trustedDevices: getTrustedDeviceCount()
    }
  };
}

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;

  if (await metaRoutes.preAuthHandle(req, res, { method, pathname })) {
    return;
  }

  if (await claudeApprovalRoute.preAuthHandle(req, res, { method, pathname })) {
    return;
  }

  if (await feishuRoutes.preAuthHandle(req, res, { method, pathname, url })) {
    return;
  }

  if (!(await requireAuth(req, res, pathname))) {
    return;
  }

  if (await metaRoutes.postAuthHandle(req, res, { method, pathname })) {
    return;
  }

  if (await feishuRoutes.postAuthHandle(req, res, { method, pathname })) {
    return;
  }

  const parts = pathname.split('/').filter(Boolean);

  if (await sessionRoutes(req, res, { method, pathname, parts, url })) {
    return;
  }

  if (await fileRoutes(req, res, url)) {
    return;
  }

  if (await pinRoutes(req, res, { method, pathname, parts })) {
    return;
  }

  if (await pushRoutes(req, res, { method, pathname, parts, url })) {
    return;
  }

  if (await peerRoutes(req, res, { method, pathname, parts, url })) {
    return;
  }

  if (await searchRoutes(req, res, { method, pathname, parts, url })) {
    return;
  }

  if (await activityRoutes(req, res, { method, pathname, parts, url })) {
    return;
  }

  if (await gitRoutes(req, res, { method, pathname, parts, url })) {
    return;
  }

  if (await fileSessionRoutes(req, res, { method, pathname, parts, url })) {
    return;
  }

  if (await quotaRoutes(req, res, { method, pathname })) {
    return;
  }

  if (await voiceRoutes(req, res, { method, pathname })) {
    return;
  }

  if (await chatRoutes(req, res, { method, pathname, parts, url })) {
    return;
  }

  if (await desktopRoutes(req, res, { method, pathname, url })) {
    return;
  }


  sendJson(res, 404, { error: 'Not found' });
}

async function requestHandler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await staticService.serveStatic(req, res, url);
  } catch (error) {
    console.error('[server] Request failed:', error);
    sendJson(res, 500, { error: error.message || 'Internal server error' });
  }
}

async function main() {
  const auth = await initializeAuth();
  await feishuRoutes.loadState();
  await chatService.loadRecentImagePrompts();
  await refreshCodexCache();
  // Catch up on terminal-started Claude sessions that accumulated while the
  // server was down — the user's flow is `claude` in the terminal, then open
  // the phone, which may not otherwise hit emitSyncComplete.
  claudeAutoTitler.schedule();

  const server = http.createServer(requestHandler);
  const wss = new WebSocketServer({ noServer: true });
  const realtimeWss = new WebSocketServer({ noServer: true });

  // Heartbeat: an iOS PWA frozen in the background leaves a half-dead TCP
  // connection that never emits 'close'. Every 25s, terminate sockets that
  // missed the previous protocol ping, then ping again and broadcast an
  // application-level heartbeat frame — browser JS cannot observe protocol
  // pings, so the JSON frame is what lets the client detect a dead server.
  const HEARTBEAT_INTERVAL_MS = 25_000;
  const heartbeatTimer = setInterval(async () => {
    // Piggyback the deployed build id so a phone that stays connected learns
    // about a rebuild within one heartbeat instead of on its next reconnect.
    const frame = JSON.stringify({ type: 'heartbeat', buildId: await getClientBuildId() });
    for (const ws of sockets) {
      if (ws.isAlive === false) {
        sockets.delete(ws);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
        ws.send(frame);
      } catch {
        // dying socket — its close handler removes it from the set
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  const handleUpgrade = async (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
    if (url.pathname !== '/ws' && url.pathname !== '/ws/realtime') {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token') || '';
    const ok = await verifyToken(token, { remoteAddress: remoteAddress(req) });
    if (!ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (url.pathname === '/ws/realtime') {
      realtimeWss.handleUpgrade(req, socket, head, (ws) => {
        startVoiceRealtimeProxy(ws, { remoteAddress: remoteAddress(req) });
      });
      return;
    }

    wss.handleUpgrade(req, socket, head, async (ws) => {
      sockets.add(ws);
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', async (raw) => {
        let frame;
        try {
          frame = JSON.parse(raw.toString('utf8'));
        } catch {
          return;
        }
        if (frame?.type === 'liveness-probe' && typeof frame.id === 'string' && frame.id.length <= 128) {
          try {
            ws.send(JSON.stringify({
              type: 'liveness-ack',
              id: frame.id,
              activeRuns: activeRunsSnapshot()
            }));
          } catch {
            // A dead socket will be removed by close/heartbeat handling.
          }
          return;
        }
        if (frame?.type === 'approval-response' && frame.requestId) {
          try {
            const { resolveCodexApproval } = await import('./codex-app-server-runner.js');
            resolveCodexApproval(frame.requestId, {
              decision: frame.decision,
              permissions: frame.permissions,
              answers: frame.answers,
              elicitationResponse: frame.elicitationResponse
            });
          } catch (error) {
            console.warn('[ws] approval-response handling failed:', error.message);
          }
        }
      });
      ws.send(JSON.stringify({ type: 'connected', status: await publicStatus(true) }));
      for (const approval of listPendingApprovals()) {
        ws.send(JSON.stringify({
          type: 'approval-request',
          ...approval
        }));
      }
    });
  };

  server.on('upgrade', handleUpgrade);

  server.listen(PORT, HOST, () => {
    // Expose the loopback URL for the Claude PreToolUse hook script (spawned
    // by Claude Code as a child of runClaudeTurn). 127.0.0.1 is intentional:
    // we only want same-host hook processes to reach the approval endpoint.
    process.env.CODEXMOBILE_INTERNAL_HOOK_URL = `http://127.0.0.1:${PORT}/api/internal/claude-approval`;
    // Persist the endpoint + per-process secret so an opt-in interactive
    // terminal (the `cmr` launcher sets CODEXMOBILE_REMOTE=1) can route its
    // tool calls to this server's PWA. Claude mode only — that's where the
    // hook + approval surface lives.
    if (isClaudeMode()) {
      const stateDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.codexmobile', 'state');
      fs.mkdir(stateDir, { recursive: true })
        .then(() => fs.writeFile(
          path.join(stateDir, 'hook-endpoint.json'),
          JSON.stringify({ url: `http://127.0.0.1:${PORT}/api/internal/claude-approval`, secret: getClaudeHookSecret() }),
          'utf8'
        ))
        .catch((err) => console.warn(`[remote-hook] failed to write endpoint file: ${err.message}`));
    }
    console.log(`CodexMobile listening on http://${HOST}:${PORT}`);
    console.log(`[startup] CODEXMOBILE_USE_IPC_TURNS=${process.env.CODEXMOBILE_USE_IPC_TURNS || '(unset)'} CODEXMOBILE_AUTO_TITLE=${process.env.CODEXMOBILE_AUTO_TITLE || '(unset)'}`);
    console.log(`Pairing code: ${getPairingCode()} (${auth.trustedDevices} trusted device(s)${auth.fixedPairingCode ? ', fixed' : ''})`);
    console.log('Use Tailscale and open http://<this-pc-tailscale-ip>:3321 on iPhone.');
    // Build the file ↔ session index in background so the first
    // /api/files/sessions request hits a warm cache. Cold-disk scan can
    // take many seconds on hosts with thousands of rollouts; doing it
    // here means it overlaps with the user's first interactions.
    fileSessionIndex.prewarm();
  });

  try {
    const pfx = await fs.readFile(HTTPS_PFX_PATH);
    const httpsServer = https.createServer({ pfx, passphrase: HTTPS_PFX_PASSPHRASE }, requestHandler);
    httpsServer.on('upgrade', handleUpgrade);
    httpsServer.listen(HTTPS_PORT, HOST, () => {
      console.log(`CodexMobile HTTPS listening on https://${HOST}:${HTTPS_PORT}`);
      if (PUBLIC_URL) {
        console.log(`Public/private URL: ${PUBLIC_URL}`);
      } else {
        console.log(`Use Tailscale HTTPS: https://<your-device>.<your-tailnet>.ts.net:${HTTPS_PORT}/`);
      }
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`CodexMobile HTTPS disabled: certificate not found at ${HTTPS_PFX_PATH}`);
    } else {
      console.warn(`[server] Failed to start HTTPS listener: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error('[server] Failed to start:', error);
  process.exitCode = 1;
});
