// useConnectionActions — owns the three connection-state UI handlers that
// used to live as inline blocks inside App.jsx.
// Pulled out as Batch G R15: pure refactor, same network call, same
// window.alert / clearToken side effects.
//
// CONNECTION_STATUS (label + className per connection state) moves here too
// because it was only used inside App.jsx; the chrome header still imports
// it back to render the connection badge.
//
// Inputs:
//   connectionState   — current connection state string ('connected' | 'connecting' | 'disconnected')
//   desktopBridge     — desktop bridge probe snapshot ({ reason, mode, ... })
//   loadStatus        — refresher from useAppBootstrap
//   setConnectionState
//   setAuthenticated
//
// Returns:
//   { handleRetryConnection, handleResetPairing, handleShowConnectionStatus }

import { clearToken } from '../api.js';
import { isClaudeProvider } from '../agent-meta.js';

export const CONNECTION_STATUS = {
  connected: { label: '已连接', className: 'is-connected' },
  connecting: { label: '连接中', className: 'is-connecting' },
  disconnected: { label: '已断开', className: 'is-disconnected' }
};

// Pure helper: the alert body for "show connection status". Exported so the
// fallback chain (label dict → raw state, reason → mode → default) can be
// tested without invoking window.alert.
export function formatConnectionStatusMessage({ connectionState, desktopBridge, provider = '' }) {
  const connectionLabel =
    CONNECTION_STATUS[connectionState]?.label || connectionState;
  if (isClaudeProvider(provider)) {
    return `连接：${connectionLabel}`;
  }
  const desktopDetail =
    desktopBridge?.reason || desktopBridge?.mode || '桌面桥接状态未返回详情。';
  return `连接：${connectionLabel}\n桌面：${desktopDetail}`;
}

export function useConnectionActions({
  connectionState,
  desktopBridge,
  provider = '',
  loadStatus,
  setConnectionState,
  setAuthenticated
}) {
  async function handleRetryConnection() {
    setConnectionState('connecting');
    try {
      await loadStatus();
    } catch (error) {
      setConnectionState('disconnected');
      window.alert(`连接失败：${error.message}`);
    }
  }

  function handleResetPairing() {
    clearToken();
    setAuthenticated(false);
    setConnectionState('disconnected');
  }

  function handleShowConnectionStatus() {
    window.alert(formatConnectionStatusMessage({ connectionState, desktopBridge, provider }));
  }

  return { handleRetryConnection, handleResetPairing, handleShowConnectionStatus };
}
