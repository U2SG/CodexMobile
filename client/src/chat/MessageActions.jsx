// Copy + more-menu action row that lives at the bottom of either a
// standalone .message-row (ChatMessage) or a multi-segment .turn-card
// (TurnGroup). Encapsulates the copy-flash timer and outside-tap
// dismissal of the more-menu so both consumers share one source of
// truth.

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, MoreVertical, Trash2 } from 'lucide-react';
import { copyTextToClipboard } from '../utils/clipboard.js';

export function MessageActions({ message, onDeleteMessage }) {
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const copiedTimerRef = useRef(null);
  const containerRef = useRef(null);
  const canDelete = Boolean(onDeleteMessage);

  useEffect(() => () => {
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;
    function handlePointerDown(event) {
      if (!containerRef.current?.contains(event.target)) {
        setMenuOpen(false);
      }
    }
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [menuOpen]);

  async function handleCopy() {
    const ok = await copyTextToClipboard(message?.content || '');
    if (!ok) {
      window.alert('复制失败');
      return;
    }
    setCopied(true);
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="message-actions" aria-label="消息操作" ref={containerRef}>
      <button type="button" className="message-action" onClick={handleCopy} aria-label={copied ? '已复制' : '复制'}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
        <span>{copied ? '已复制' : '复制'}</span>
      </button>
      {canDelete ? (
        <div className="message-more-wrap">
          <button
            type="button"
            className="message-action message-more-trigger"
            aria-label="更多操作"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <MoreVertical size={14} />
          </button>
          {menuOpen ? (
            <div className="message-action-menu" role="menu">
              <button
                type="button"
                className="message-action-menu-item is-delete"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onDeleteMessage?.(message);
                }}
              >
                <Trash2 size={14} />
                <span>删除</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
