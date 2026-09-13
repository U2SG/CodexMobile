// Chrome header rendered at the top of the chat shell. Shows the menu /
// docs buttons, the current project label, the agent + connection +
// desktop-bridge pills, and the shortened project path.
//
// Extracted from App.jsx (Batch G R19). All inputs flow in as props;
// no App-scope state.

import { useLayoutEffect, useRef, useState } from 'react';
import { Menu, Wifi, ChevronDown } from 'lucide-react';
import { agentMeta } from '../agent-meta.js';
import { CONNECTION_STATUS } from '../app/useConnectionActions.js';
import { FeishuLogoIcon } from '../FeishuLogoIcon.jsx';
import { compactPath } from '../utils/path.js';

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
  connectionState,
  onMenu,
  onOpenDocs,
  status,
  desktopBridge,
  peers = []
}) {
  const connection = CONNECTION_STATUS[connectionState] || CONNECTION_STATUS.disconnected;
  const agent = agentMeta(status);
  const projectName = selectedProject?.name || agent.label;
  const projectTitle = selectedProject?.path ? `${projectName}\n${selectedProject.path}` : projectName;
  const displayProjectName = compactProjectName(projectName);
  const projectPath = selectedProject?.path ? compactPath(selectedProject.path) : '';
  const desktopOnline = desktopBridge?.connected;
  const desktopLabel = desktopOnline ? '桌面端在线' : (desktopBridge?.reason || '桌面端离线');
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
      <div className="top-title" title={projectTitle} aria-label={projectTitle}>
        <strong>{displayProjectName}</strong>
        <span className="top-meta">
          {hasPeers ? (
            <span className="peer-switcher">
              <button
                ref={peerButtonRef}
                type="button"
                className={`connection-status peer-pill ${connection.className}`}
                onClick={() => setPeerMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={peerMenuOpen}
                title="切换到其他 CodexMobile 服务器"
              >
                <Wifi size={13} />
                {agent.shortLabel} · {connection.label}
                <ChevronDown size={11} />
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
            <span className={`connection-status ${connection.className}`}>
              <Wifi size={13} />
              {agent.shortLabel} · {connection.label}
            </span>
          )}
          <span
            className="connection-status desktop-pill"
            title={desktopLabel}
            aria-label={desktopLabel}
          >
            <span className={`desktop-dot ${desktopOnline ? 'is-online' : 'is-offline'}`} />
            桌面
          </span>
          {projectPath ? <span className="top-project-path" title={selectedProject.path}>{projectPath}</span> : null}
        </span>
      </div>
      <button type="button" className="icon-button" onClick={onOpenDocs} aria-label="打开文档">
        <FeishuLogoIcon size={23} className="top-docs-logo" />
      </button>
    </header>
  );
}
