// Feishu (Lark) integration routes — OAuth user-auth flow + lark-cli
// device-code flow + public status + logout. Encapsulates the
// feishuAuthState mutable singleton (token + pendingStates) and the
// per-request OAuth helpers inside the factory closure.
//
// Extracted from server/index.js (Batch G R27).
//
// Routes:
//   GET  /api/feishu/auth/callback         — PRE-AUTH (OAuth provider redirect)
//   GET  /api/feishu/status                — post-auth
//   POST /api/feishu/cli/auth/start        — post-auth (lark-cli device flow)
//   POST /api/feishu/cli/auth/logout       — post-auth (lark-cli logout)
//   POST /api/feishu/auth/start            — post-auth (mint OAuth state + redirect URL)
//   POST /api/feishu/auth/logout           — post-auth (clear stored token)
//
// Dispatcher wires preAuthHandle() before requireAuth, postAuthHandle()
// after requireAuth. loadState() is called once at server boot to
// rehydrate the persisted token + pending states.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { htmlEscape, sendHtml, sendJson } from './http-utils.js';

export function createFeishuRoutes({
  config,
  port,
  getLarkDocsStatus,
  startLarkCliAuth,
  logoutLarkCli,
  remoteAddress
}) {
  if (!config) throw new Error('createFeishuRoutes: config is required');
  if (typeof getLarkDocsStatus !== 'function') throw new Error('createFeishuRoutes: getLarkDocsStatus is required');
  if (typeof startLarkCliAuth !== 'function') throw new Error('createFeishuRoutes: startLarkCliAuth is required');
  if (typeof logoutLarkCli !== 'function') throw new Error('createFeishuRoutes: logoutLarkCli is required');
  if (typeof remoteAddress !== 'function') throw new Error('createFeishuRoutes: remoteAddress is required');

  const {
    appId,
    appSecret,
    redirectUriOverride,
    authStatePath,
    authStateMaxAgeMs = 15 * 60 * 1000,
    docsHomeUrl,
    publicUrl
  } = config;

  let state = { token: null, pendingStates: {} };

  async function loadState() {
    try {
      const raw = await fs.readFile(authStatePath, 'utf8');
      const parsed = JSON.parse(raw);
      state = {
        token: parsed?.token && typeof parsed.token === 'object' ? parsed.token : null,
        pendingStates: parsed?.pendingStates && typeof parsed.pendingStates === 'object' ? parsed.pendingStates : {}
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[feishu] Failed to read auth state:', error.message);
      }
      state = { token: null, pendingStates: {} };
    }
  }

  async function saveState() {
    await fs.mkdir(path.dirname(authStatePath), { recursive: true });
    await fs.writeFile(authStatePath, JSON.stringify(state, null, 2), 'utf8');
  }

  function cleanupPendingStates() {
    const now = Date.now();
    const next = {};
    for (const [key, payload] of Object.entries(state.pendingStates || {})) {
      const createdAt = Number(payload?.createdAt || 0);
      if (createdAt && now - createdAt <= authStateMaxAgeMs) {
        next[key] = payload;
      }
    }
    state.pendingStates = next;
  }

  function requestOrigin(req) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const proto = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${port}`;
    return `${proto}://${String(host).split(',')[0].trim()}`;
  }

  function redirectUri(req) {
    if (redirectUriOverride) {
      return redirectUriOverride;
    }
    const base = publicUrl || requestOrigin(req);
    return new URL('/api/feishu/auth/callback', base.endsWith('/') ? base : `${base}/`).toString();
  }

  function configured() {
    return Boolean(appId && appSecret);
  }

  function tokenValid() {
    const expiresAt = Number(state.token?.expiresAt || 0);
    return Boolean(state.token?.accessToken && expiresAt && expiresAt > Date.now() + 60_000);
  }

  function userSummary() {
    const user = state.token?.user || {};
    const name = user.name || user.enName || user.email || user.enterpriseEmail || user.openId || '';
    return name ? {
      name,
      email: user.email || user.enterpriseEmail || '',
      openId: user.openId || ''
    } : null;
  }

  async function publicDocsStatus(authenticated) {
    try {
      return await getLarkDocsStatus({ authenticated });
    } catch (error) {
      return {
        provider: 'feishu',
        integration: 'lark-cli',
        label: '飞书文档',
        configured: configured(),
        connected: authenticated ? tokenValid() : false,
        user: authenticated ? userSummary() : null,
        homeUrl: docsHomeUrl,
        cliInstalled: false,
        skillsInstalled: false,
        capabilities: [],
        codexEnabled: false,
        error: error.message || 'lark-cli status failed'
      };
    }
  }

  async function feishuJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 1000) };
    }
    if (!response.ok || Number(data.code || 0) !== 0) {
      const error = new Error(data.msg || data.message || `Feishu API request failed: ${response.status}`);
      error.statusCode = response.status;
      error.response = data;
      throw error;
    }
    return data;
  }

  async function getAppAccessToken() {
    if (!configured()) {
      const error = new Error('Feishu app credentials are not configured');
      error.statusCode = 400;
      throw error;
    }
    const data = await feishuJson('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
      method: 'POST',
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    });
    return data.app_access_token;
  }

  async function exchangeCode(code) {
    const appAccessToken = await getAppAccessToken();
    const data = await feishuJson('https://open.feishu.cn/open-apis/authen/v1/access_token', {
      method: 'POST',
      headers: { authorization: `Bearer ${appAccessToken}` },
      body: JSON.stringify({ grant_type: 'authorization_code', code })
    });
    const token = data.data || data;
    const now = Date.now();
    state.token = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || '',
      expiresAt: now + Math.max(0, Number(token.expires_in || 0)) * 1000,
      refreshExpiresAt: token.refresh_expires_in ? now + Number(token.refresh_expires_in) * 1000 : 0,
      user: {
        name: token.name || '',
        enName: token.en_name || '',
        email: token.email || '',
        enterpriseEmail: token.enterprise_email || '',
        openId: token.open_id || '',
        unionId: token.union_id || '',
        userId: token.user_id || '',
        tenantKey: token.tenant_key || ''
      },
      updatedAt: new Date().toISOString()
    };
    await saveState();
    return state.token;
  }

  async function handleCallback(req, res, url) {
    const code = String(url.searchParams.get('code') || '').trim();
    const stateParam = String(url.searchParams.get('state') || '').trim();
    const errorParam = String(url.searchParams.get('error') || '').trim();
    cleanupPendingStates();
    const pending = stateParam ? state.pendingStates[stateParam] : null;
    if (!pending) {
      sendHtml(res, 400, '<!doctype html><meta charset="utf-8"><p>飞书授权已过期，请回到 CodexMobile 重新连接。</p>');
      return;
    }
    delete state.pendingStates[stateParam];
    await saveState();
    if (errorParam) {
      sendHtml(res, 400, `<!doctype html><meta charset="utf-8"><p>飞书授权失败：${htmlEscape(errorParam)}</p>`);
      return;
    }
    if (!code) {
      sendHtml(res, 400, '<!doctype html><meta charset="utf-8"><p>飞书授权失败：没有收到授权码。</p>');
      return;
    }
    try {
      await exchangeCode(code);
      const backUrl = new URL('/', pending.redirectUri).toString();
      res.writeHead(302, { location: `${backUrl}?feishu=connected` });
      res.end();
    } catch (callbackError) {
      console.warn(`[feishu] OAuth callback failed remote=${remoteAddress(req)} message=${callbackError.message}`);
      sendHtml(res, 502, `<!doctype html><meta charset="utf-8"><p>飞书授权失败：${htmlEscape(callbackError.message)}</p>`);
    }
  }

  async function preAuthHandle(req, res, ctx) {
    if (ctx.method === 'GET' && ctx.pathname === '/api/feishu/auth/callback') {
      await handleCallback(req, res, ctx.url);
      return true;
    }
    return false;
  }

  async function postAuthHandle(req, res, ctx) {
    const { method, pathname } = ctx;

    if (method === 'GET' && pathname === '/api/feishu/status') {
      sendJson(res, 200, await publicDocsStatus(true));
      return true;
    }

    if (method === 'POST' && pathname === '/api/feishu/cli/auth/start') {
      try {
        const auth = await startLarkCliAuth();
        sendJson(res, 200, {
          success: true,
          ...auth,
          docs: await publicDocsStatus(true)
        });
      } catch (error) {
        const statusCode = error.statusCode || 502;
        console.warn(`[lark-cli] auth start failed remote=${remoteAddress(req)} message=${error.message}`);
        sendJson(res, statusCode, { error: error.message || '飞书 CLI 授权失败' });
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/feishu/cli/auth/logout') {
      try {
        await logoutLarkCli();
        sendJson(res, 200, {
          success: true,
          docs: await publicDocsStatus(true)
        });
      } catch (error) {
        const statusCode = error.statusCode || 502;
        console.warn(`[lark-cli] auth logout failed remote=${remoteAddress(req)} message=${error.message}`);
        sendJson(res, statusCode, { error: error.message || '断开飞书 CLI 授权失败' });
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/feishu/auth/start') {
      if (!configured()) {
        sendJson(res, 400, { error: 'Feishu app credentials are not configured' });
        return true;
      }
      cleanupPendingStates();
      const stateKey = crypto.randomBytes(24).toString('base64url');
      const uri = redirectUri(req);
      state.pendingStates[stateKey] = { createdAt: Date.now(), redirectUri: uri };
      await saveState();
      const authUrl = new URL('https://open.feishu.cn/open-apis/authen/v1/index');
      authUrl.searchParams.set('app_id', appId);
      authUrl.searchParams.set('redirect_uri', uri);
      authUrl.searchParams.set('state', stateKey);
      sendJson(res, 200, { url: authUrl.toString(), redirectUri: uri });
      return true;
    }

    if (method === 'POST' && pathname === '/api/feishu/auth/logout') {
      state.token = null;
      await saveState();
      sendJson(res, 200, { success: true, ...(await publicDocsStatus(true)) });
      return true;
    }

    return false;
  }

  // Exposed for the chat service factory which still passes
  // publicDocsStatus into other modules; also useful for tests.
  return {
    loadState,
    preAuthHandle,
    postAuthHandle,
    publicDocsStatus
  };
}
