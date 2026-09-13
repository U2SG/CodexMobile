// Copy a Claude session id to clipboard so the user can resume it from the
// desktop terminal with `claude --resume <id>`. Mobile-created sessions
// run via `claude -p` (entrypoint=sdk-cli) and Claude Code deliberately
// hides those from the interactive /resume picker — direct-by-id resume
// is the only supported path (see docs/sessions.md upstream).
//
// Extracted from App.jsx (Batch G R18). Self-contained: only depends on
// lucide-react icons and the shared clipboard helper; no App-scope state.

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyTextToClipboard } from '../utils/clipboard.js';

export function CopyResumeButton({ sessionId, title }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);
  if (!sessionId) return null;
  async function handleClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const ok = await copyTextToClipboard(sessionId);
    if (!ok) {
      window.alert('复制失败');
      return;
    }
    setCopied(true);
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }
  const label = title || '复制 session id（终端用 claude --resume <id> 恢复）';
  return (
    <button
      type="button"
      className="thread-copy-resume"
      onClick={handleClick}
      aria-label={label}
      title={label}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}
