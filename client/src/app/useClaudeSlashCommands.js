// Fetches the union of Claude CLI built-in + user + project slash commands
// from GET /api/claude/slash-commands. Skips the request entirely on the
// codex route — server returns [] there, but avoiding the round-trip keeps
// the codex composer free of needless network traffic.
//
// Refresh triggers: agent change, project change, explicit refresh() call
// (e.g. composer opening the `/` picker). The 30-second throttle on
// refresh() matches the server-side cache so opening the picker repeatedly
// doesn't hammer the server, but newly-added ~/.claude/skills or
// ~/.claude/commands appear without needing to switch sessions.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api.js';

const REFRESH_TTL_MS = 30_000;

export function useClaudeSlashCommands({ authenticated, agentId, projectId }) {
  const [commands, setCommands] = useState([]);
  const lastLoadedAtRef = useRef(0);

  const load = useCallback(async () => {
    if (!authenticated || agentId !== 'claude') {
      setCommands([]);
      lastLoadedAtRef.current = 0;
      return;
    }
    try {
      const search = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      const data = await apiFetch(`/api/claude/slash-commands${search}`);
      setCommands(Array.isArray(data?.commands) ? data.commands : []);
      lastLoadedAtRef.current = Date.now();
    } catch {
      setCommands([]);
    }
  }, [authenticated, agentId, projectId]);

  const refresh = useCallback(() => {
    if (Date.now() - lastLoadedAtRef.current < REFRESH_TTL_MS) return;
    load();
  }, [load]);

  useEffect(() => {
    lastLoadedAtRef.current = 0;
    load();
  }, [load]);

  return { claudeSlashCommands: commands, refreshClaudeSlashCommands: refresh };
}
