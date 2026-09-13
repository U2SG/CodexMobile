// Feishu (Lark) docs side panel. Shows the lark-cli / skills / app-config /
// user-auth status, surfaces any pending device-code authorization flow,
// and exposes connect / disconnect / refresh actions. Renders nothing when
// `open` is false.
//
// Extracted from App.jsx (Batch G R20). Pure presentation — all data and
// handlers flow in as props; no App-scope state.

import {
  Check,
  ChevronLeft,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X
} from 'lucide-react';
import { FeishuLogoIcon } from '../FeishuLogoIcon.jsx';

export function DocsPanel({
  open,
  docs,
  busy,
  error,
  onClose,
  onConnect,
  onDisconnect,
  onOpenHome,
  onOpenAuth,
  onRefresh
}) {
  if (!open) {
    return null;
  }

  const cliInstalled = Boolean(docs?.cliInstalled);
  const skillsInstalled = Boolean(docs?.skillsInstalled);
  const configured = Boolean(docs?.configured);
  const connected = Boolean(docs?.connected);
  const authorizationReady = connected && Boolean(docs?.authorizationReady);
  const missingScopes = Array.isArray(docs?.missingScopes) ? docs.missingScopes : [];
  const needsExtraAuth = connected && (!authorizationReady || missingScopes.length > 0);
  const slidesAuthorized = connected && Boolean(docs?.slidesAuthorized);
  const sheetsAuthorized = connected && Boolean(docs?.sheetsAuthorized);
  const authPending = docs?.authPending;
  const setupItems = [
    { id: 'cli', label: 'lark-cli', ok: cliInstalled },
    { id: 'skills', label: '官方 skills', ok: skillsInstalled },
    { id: 'config', label: 'App 凭证', ok: configured },
    { id: 'auth', label: '用户授权', ok: connected },
    { id: 'slides', label: 'PPT 权限', ok: slidesAuthorized },
    { id: 'sheets', label: '表格权限', ok: sheetsAuthorized }
  ];
  const subtitle = connected
    ? needsExtraAuth
      ? '待补权限'
      : ''
    : authPending?.status === 'polling'
      ? '等待授权'
      : configured
        ? '未连接'
        : '未配置';
  const summary = authPending?.status === 'polling'
      ? '授权页已打开，完成后回到这里刷新状态。'
      : connected
        ? needsExtraAuth
          ? '飞书账号已连接，但部分文档权限还没授权。补充授权后，Codex 可完整操作飞书文档、PPT、表格和云空间文件。'
          : 'Codex 已可操作飞书文档、PPT、表格和云空间文件。'
        : !cliInstalled
          ? '本机还没有检测到 lark-cli。'
          : !skillsInstalled
            ? '官方文档 skills 还没有安装完整。'
            : configured
              ? '连接飞书账号后，Codex 才能以你的身份操作文档、PPT 和表格。'
              : '请先在后端配置飞书 App ID 和 Secret。';
  const canConnect = cliInstalled && skillsInstalled && configured;

  return (
    <section className="docs-panel" role="dialog" aria-modal="true" aria-label="飞书文档">
      <header className="docs-panel-header">
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭文档">
          <ChevronLeft size={22} />
        </button>
        <div className="docs-panel-title">
          <strong>飞书文档</strong>
          {subtitle ? <span>{subtitle}</span> : null}
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭文档">
          <X size={20} />
        </button>
      </header>
      <div className="docs-panel-body">
        <div className="docs-status-state">
          <div className="docs-status-icon">
            <FeishuLogoIcon size={58} />
          </div>
          <h2>飞书文档</h2>
          <p>{summary}</p>
          {error ? <div className="docs-panel-error">{error}</div> : null}
          {authPending?.verificationUrl && (!connected || needsExtraAuth) ? (
            <div className="docs-auth-box">
              <span>授权码 {authPending.userCode || '已生成'}</span>
              <button type="button" onClick={() => onOpenAuth(authPending.verificationUrl)}>
                打开授权页
              </button>
            </div>
          ) : null}
          <div className="docs-check-list">
            {setupItems.map((item) => (
              <div key={item.id} className={item.ok ? 'is-ok' : ''}>
                {item.ok ? <Check size={15} /> : <X size={15} />}
                <span>{item.label}</span>
              </div>
            ))}
          </div>
          {needsExtraAuth && missingScopes.length ? (
            <div className="docs-scope-hint">
              缺少 {missingScopes.slice(0, 4).join('、')}
            </div>
          ) : null}
          <div className="docs-panel-actions">
            {connected ? (
              <>
                <button type="button" onClick={needsExtraAuth ? onConnect : onOpenHome} disabled={needsExtraAuth && busy}>
                  {needsExtraAuth ? (
                    busy ? <Loader2 className="spin" size={16} /> : <ShieldCheck size={16} />
                  ) : (
                    <FeishuLogoIcon size={18} />
                  )}
                  {needsExtraAuth ? '补充授权' : '打开飞书'}
                </button>
                <button type="button" onClick={onDisconnect} disabled={busy}>
                  {busy ? <Loader2 className="spin" size={16} /> : <X size={16} />}
                  断开
                </button>
                <button type="button" onClick={onRefresh} disabled={busy}>
                  <RefreshCw size={16} />
                  刷新
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={onConnect} disabled={!canConnect || busy}>
                  {busy ? <Loader2 className="spin" size={16} /> : <ShieldCheck size={16} />}
                  连接飞书
                </button>
                <button type="button" onClick={onRefresh} disabled={busy}>
                  <RefreshCw size={16} />
                  刷新
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
