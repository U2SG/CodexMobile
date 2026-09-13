import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, BellOff, Send } from 'lucide-react';
import { apiFetch } from './api.js';
import './notifications.css';

const SW_PATH = '/sw.js';

/* Standard helper: VAPID public key (base64url) → Uint8Array. */
function urlBase64ToUint8Array(base64String) {
  if (!base64String) return new Uint8Array();
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function browserSupportsPush() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

async function ensureRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  // Reuse an existing registration if one is already live for our SW path.
  const existing = await navigator.serviceWorker.getRegistration(SW_PATH);
  if (existing) return existing;
  return navigator.serviceWorker.register(SW_PATH);
}

export function NotificationSettings({ apiBase = '' } = {}) {
  const base = apiBase.replace(/\/+$/, '');
  const path = useCallback((p) => `${base}${p}`, [base]);

  const [supported] = useState(() => browserSupportsPush());
  const [permission, setPermission] = useState(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );
  const [status, setStatus] = useState(null);
  const [hasLocalSub, setHasLocalSub] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshLocalSubscription = useCallback(async () => {
    if (!supported) return false;
    try {
      const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
      if (!reg) {
        if (mounted.current) setHasLocalSub(false);
        return false;
      }
      const sub = await reg.pushManager.getSubscription();
      const has = !!sub;
      if (mounted.current) setHasLocalSub(has);
      return has;
    } catch (err) {
      if (mounted.current) setHasLocalSub(false);
      return false;
    }
  }, [supported]);

  const refreshStatus = useCallback(async () => {
    try {
      const data = await apiFetch(path('/api/notifications/status'));
      if (mounted.current) setStatus(data);
    } catch (err) {
      if (mounted.current) setError(err.message || '获取状态失败');
    }
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supported) {
        await refreshStatus();
        return;
      }
      try {
        await ensureRegistration();
      } catch (err) {
        if (!cancelled && mounted.current) {
          setError(`Service Worker 注册失败: ${err.message || err}`);
        }
      }
      if (!cancelled) {
        await refreshStatus();
        await refreshLocalSubscription();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported, refreshStatus, refreshLocalSubscription]);

  const enable = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setInfo('');
    try {
      if (!supported) throw new Error('当前浏览器不支持 Web Push。');
      if (!status || !status.publicKey) {
        throw new Error('服务端未提供 VAPID 公钥，无法订阅。');
      }
      const perm = await Notification.requestPermission();
      if (mounted.current) setPermission(perm);
      if (perm === 'denied') {
        throw new Error('通知权限被拒绝。请在系统设置里授权通知，再重试。');
      }
      if (perm !== 'granted') {
        throw new Error('未获得通知权限。');
      }
      await ensureRegistration();
      const reg = await navigator.serviceWorker.ready;

      // Avoid duplicate subscribe — reuse if it already exists.
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(status.publicKey)
        });
      }
      await apiFetch(path('/api/notifications/subscribe'), {
        method: 'POST',
        body: sub.toJSON()
      });
      if (mounted.current) {
        setInfo('已启用推送通知。');
        setHasLocalSub(true);
      }
      await refreshStatus();
    } catch (err) {
      if (mounted.current) setError(err.message || '启用通知失败');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [busy, supported, status, path, refreshStatus]);

  const disable = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setInfo('');
    try {
      if (!supported) throw new Error('当前浏览器不支持 Web Push。');
      const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        try {
          await apiFetch(path('/api/notifications/unsubscribe'), {
            method: 'POST',
            body: { endpoint: sub.endpoint }
          });
        } catch (err) {
          // Even if the server doesn't know about it, still drop locally.
          if (mounted.current) {
            setInfo(`服务端取消订阅返回提示: ${err.message || err}`);
          }
        }
        try {
          await sub.unsubscribe();
        } catch (_) {
          /* ignore */
        }
      }
      if (mounted.current) {
        setHasLocalSub(false);
        if (!info) setInfo('已取消订阅。');
      }
      await refreshStatus();
    } catch (err) {
      if (mounted.current) setError(err.message || '取消订阅失败');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [busy, supported, path, info, refreshStatus]);

  const sendTest = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const data = await apiFetch(path('/api/notifications/test'), { method: 'POST' });
      const sent = data?.sent ?? data?.delivered ?? data?.count;
      const total = data?.total ?? data?.subscribers ?? data?.subscriberCount;
      if (typeof sent !== 'undefined' && typeof total !== 'undefined') {
        setInfo(`测试通知已发送 (${sent}/${total})。`);
      } else if (typeof sent !== 'undefined') {
        setInfo(`测试通知已发送 (${sent})。`);
      } else {
        setInfo('测试通知已发送。');
      }
    } catch (err) {
      setError(err.message || '发送测试通知失败');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [busy, path]);

  const enabled = supported && permission === 'granted' && hasLocalSub;

  const supportLine = useMemo(() => {
    if (!supported) return '不支持';
    if (permission === 'denied') return '权限被拒绝';
    if (permission === 'default') return '支持 (尚未授权)';
    return '支持';
  }, [supported, permission]);

  const keyAvailable = !!(status && status.publicKey);
  const subscriberCount =
    status && typeof status.subscriberCount === 'number' ? status.subscriberCount : '—';

  return (
    <div className="push-settings">
      <div className="push-settings-card">
        <div className="row">
          <span className="row-label">浏览器支持</span>
          <span className={`row-value${supported ? '' : ' is-warn'}`}>{supportLine}</span>
        </div>
        <div className="row">
          <span className="row-label">VAPID 公钥</span>
          <span className={`row-value${keyAvailable ? '' : ' is-warn'}`}>
            {keyAvailable ? '可用' : '未配置'}
          </span>
        </div>
        <div className="row">
          <span className="row-label">当前订阅数</span>
          <span className="row-value">{subscriberCount}</span>
        </div>
        {status && status.subject ? (
          <div className="row">
            <span className="row-label">联系地址</span>
            <span className="row-value is-muted">{status.subject}</span>
          </div>
        ) : null}

        <div className="actions">
          {enabled ? (
            <button
              type="button"
              className="button-primary is-danger"
              onClick={disable}
              disabled={busy}
            >
              <BellOff size={18} aria-hidden="true" />
              <span>{busy ? '处理中…' : '已启用 — 取消订阅'}</span>
            </button>
          ) : (
            <button
              type="button"
              className="button-primary"
              onClick={enable}
              disabled={busy || !supported || !keyAvailable}
            >
              <Bell size={18} aria-hidden="true" />
              <span>{busy ? '处理中…' : '启用通知'}</span>
            </button>
          )}

          {supported && permission === 'granted' ? (
            <button
              type="button"
              className="button-ghost"
              onClick={sendTest}
              disabled={busy}
            >
              <Send size={16} aria-hidden="true" />
              <span>发送测试通知</span>
            </button>
          ) : null}
        </div>

        {error ? (
          <div className="banner is-error" role="alert">
            {error}
          </div>
        ) : null}
        {info && !error ? (
          <div className="banner is-info" role="status">
            {info}
          </div>
        ) : null}
        {!supported ? (
          <div className="banner is-info">
            提示: iOS 上需将本应用作为 PWA 添加到主屏幕，并在 HTTPS 下访问，才能启用通知。
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default NotificationSettings;
