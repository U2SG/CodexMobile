// Chrome header rendered at the top of the chat shell. Keeps the current
// session title primary, with project + agent connection as compact secondary
// context; paths and desktop diagnostics live behind detail actions.
//
// Extracted from App.jsx (Batch G R19). All inputs flow in as props;
// no App-scope state.

import { useLayoutEffect, useRef, useState } from 'react';
import { Menu, Wifi, ChevronDown } from 'lucide-react';
import { agentMeta } from '../agent-meta.js';
import { CONNECTION_STATUS } from '../app/useConnectionActions.js';
import { FeishuLogoIcon } from '../FeishuLogoIcon.jsx';

function compactProjectName(name, max = 26) {
  const value = String(name || '').trim();
  if (value.length <= max) {
    return value;
  }
  const head = Math.max(10, Math.floor(max * 0.62));
  const tail = Math.max(6, max - head - 1);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function TopBar({
  selectedProject,
  selectedSession,
  connectionState,
  onMenu,
  onOpenDocs,
  onShowConnectionStatus,
  status,
  desktopBridge,
  peers = []
}) {
  const connection = CONNECTION_STATUS[connectionState] || CONNECTION_STATUS.disconnected;
  const agent = agentMeta(status);
  const projectName = selectedProject?.name || agent.label;
  const sessionTitle = String(selectedSession?.title || '').trim() || projectName;
  const displaySessionTitle = compactProjectName(sessionTitle, 32);
  const displayProjectName = compactProjectName(projectName, 20);
  const showProjectContext = Boolean(selectedSession && projectName && sessionTitle !== projectName);
  const headerTitle = [
    sessionTitle,
    showProjectContext ? projectName : null,
    selectedProject?.path || null
  ].filter(Boolean).join('\n');
  const desktopOnline = desktopBridge?.connected;
  const desktopLabel = desktopOnline ? '桌面端在线' : (desktopBridge?.reason || '桌面端离线');
  const diagnosticDetail = agent.id === 'codex'
    ? desktopLabel
    : `${agent.label} · ${connection.label}`;
  const [peerMenuOpen, setPeerMenuOpen] = useState(false);
  const [peerMenuPos, setPeerMenuPos] = useState(null);
  const peerButtonRef = useRef(null);
  const hasPeers = Array.isArray(peers) && peers.length > 0;

  // The peer-menu is rendered inside .top-title which has overflow:hidden
  // (mobile pill chrome clips it). Escape via position:fixed and anchor to
  // the button's bounding rect every time the menu opens.
  useLayoutEffect(() => {
    if (!peerMenuOpen || !peerButtonRef.current) return undefined;
    function place() {
      const rect = peerButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPeerMenuPos({ top: rect.bottom + 6, left: rect.left });
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [peerMenuOpen]);

  function navigateToPeer(url) {
    if (typeof url !== 'string' || !url) return;
    setPeerMenuOpen(false);
    // window.location.href so the destination PWA gets a full reload —
    // it'll mount with its own paired token + drawer + chat state.
    if (typeof window !== 'undefined') {
      window.location.href = url;
    }
  }

  return (
    <header className={`top-bar ${agent.accentClass}`}>
      <button className="icon-button" onClick={onMenu} aria-label="打开菜单">
        <Menu size={22} />
      </button>
      <div className="top-title" title={headerTitle} aria-label={headerTitle}>
        <strong>{displaySessionTitle}</strong>
        <span className={`top-meta ${showProjectContext ? 'has-project-context' : 'is-status-only'}`}>
          {showProjectContext ? (
            <span className="top-project-context" title={selectedProject?.path || projectName}>
              {displayProjectName}
            </span>
          ) : null}
          {hasPeers ? (
            <span className="peer-switcher">
              <button
                ref={peerButtonRef}
                type="button"
                className={`connection-status peer-pill ${connection.className}`}
                onClick={() => setPeerMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={peerMenuOpen}
                aria-label={`${agent.label} ${connection.label}，切换 Agent 或查看连接详情`}
                title="切换 Agent 或查看连接详情"
              >
                <Wifi size={12} />
                {agent.shortLabel} · {connection.label}
                <ChevronDown size={10} />
              </button>
              {peerMenuOpen && peerMenuPos ? (
                <>
                  <div
                    className="peer-menu-backdrop"
                    onClick={() => setPeerMenuOpen(false)}
                    aria-hidden="true"
                  />
                  <div
                    className="peer-menu"
                    role="menu"
                    style={{ position: 'fixed', top: peerMenuPos.top, left: peerMenuPos.left }}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="peer-menu-item peer-menu-status"
                      onClick={() => {
                        setPeerMenuOpen(false);
                        onShowConnectionStatus?.();
                      }}
                    >
                      <strong>连接详情</strong>
                      <small>{diagnosticDetail}</small>
                    </button>
                    {peers.map((peer) => (
                      <button
                        key={peer.url}
                        type="button"
                        role="menuitem"
                        className="peer-menu-item"
                        onClick={() => navigateToPeer(peer.url)}
                        title={peer.url}
                      >
                        <strong>{peer.label}</strong>
                        <small>{peer.url}</small>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </span>
          ) : (
            <span
              className={`connection-status ${connection.className}`}
              aria-label={`${agent.label} ${connection.label}`}
            >
              <Wifi size={12} />
              {agent.shortLabel} · {connection.label}
            </span>
          )}
        </span>
      </div>
      <button type="button" className="icon-button" onClick={onOpenDocs} aria-label="打开文档">
        <FeishuLogoIcon size={23} className="top-docs-logo" />
      </button>
    </header>
  );
}
