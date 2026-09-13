// /api/peers — list of sibling CodexMobile servers the PWA can quick-switch
// to. Designed for the typical dual-deploy: one server running in codex
// mode, another in claude mode, both reachable via Tailscale. Configure
// via the CODEXMOBILE_PEER_URLS env var (comma-separated). Each entry can
// be a bare URL or a `Label|URL` pair so the dropdown can show a human
// label:
//
//   CODEXMOBILE_PEER_URLS="Claude|https://agent-host.example,Codex|https://agent-host.example:8443"
//
// The PWA fetches this once on mount; no server-to-server probing here.
// Each peer is just a URL pointer — clicking navigates the browser there,
// where the user has already paired and stored a device token.

import { sendJson } from './http-utils.js';

const KNOWN_AGENTS = new Set(['codex', 'claude']);

export function parsePeerUrls(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const out = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Entry shapes (pipe-separated, in order of length):
    //   "https://..."                 — bare URL, derive label from host
    //   "Label|https://..."           — 2-segment
    //   "Label|agent|https://..."     — 3-segment, agent tag enables
    //                                   peer-aware deep linking from
    //                                   foreign-agent badges
    //
    // Strategy: URL is always the last segment. Of the remaining segments,
    // pluck a known agent token if present; everything else becomes the
    // label. Lets unknown middle segments fall into the label instead of
    // breaking the whole entry.
    const segments = trimmed.split('|').map((s) => s.trim());
    const url = segments.pop();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    let agent;
    let label = '';
    if (segments.length === 0) {
      // bare URL
    } else if (segments.length === 1) {
      // 2-segment form is strictly Label|URL — don't try to interpret
      // the label as an agent. Users with single-pipe entries shouldn't
      // need to add a redundant agent name.
      label = segments[0];
    } else {
      // 3+ segments: positional — first segment is the label, second
      // segment is the agent tag IF it's a known agent token (codex /
      // claude, case-insensitive). Anything else lands in the label so
      // an unknown middle segment doesn't break the whole entry.
      const remainder = [];
      const maybeAgent = segments[1] ? segments[1].toLowerCase() : '';
      if (KNOWN_AGENTS.has(maybeAgent)) {
        agent = maybeAgent;
        if (segments[0]) remainder.push(segments[0]);
        for (let i = 2; i < segments.length; i += 1) {
          if (segments[i]) remainder.push(segments[i]);
        }
      } else {
        for (const segment of segments) {
          if (segment) remainder.push(segment);
        }
      }
      label = remainder.join(' | ');
    }
    const peer = {
      url,
      label: label || hostnameLabel(url)
    };
    if (agent) peer.agent = agent;
    out.push(peer);
  }
  return out;
}

function hostnameLabel(url) {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url;
  }
}

export function createPeerRoutes({ peerUrlsRaw = '' } = {}) {
  const peers = parsePeerUrls(peerUrlsRaw);
  return async function handle(req, res, ctx) {
    const { method, pathname } = ctx;
    if (method !== 'GET' || pathname !== '/api/peers') return false;
    sendJson(res, 200, { peers });
    return true;
  };
}
