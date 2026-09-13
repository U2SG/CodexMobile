import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function isContinuationMessage(message) {
  return /^(继续|中断了|又中断了|断了|重新来|重新生成|重新发送|再来|再试一次|retry|continue)$/i.test(String(message || '').trim());
}

export function parseExplicitImageCommand(message) {
  const value = String(message || '').trim();
  const match = value.match(/^\/(?:image|img|生成图片|edit-image)\s+([\s\S]+)$/i);
  if (!match) return null;
  return match[1].trim();
}

export function createChatImageHandler({
  imagePromptState,
  runImageTurn,
  isImageRequest,
  analyzeImageIntent,
  listProjectSessions,
  refreshCodexCache,
  broadcast,
  rememberTurn,
  emitJobEvent
}) {
  const recentImagePromptsByProject = new Map();
  const recentImagePromptsBySession = new Map();
  const activeImageRuns = new Map();

  function getActiveImageRuns() {
    return [...activeImageRuns.values()].map((run) => ({
      sessionId: run.sessionId,
      previousSessionId: run.previousSessionId,
      startedAt: run.startedAt,
      status: run.status,
      turnId: run.turnId,
      kind: 'image_generation_call',
      label: run.label
    }));
  }

  async function loadRecentImagePrompts() {
    try {
      const raw = await fs.readFile(imagePromptState, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [projectId, entry] of Object.entries(parsed.projects || {})) {
        if (entry?.prompt) recentImagePromptsByProject.set(projectId, entry.prompt);
      }
      for (const [sessionId, entry] of Object.entries(parsed.sessions || {})) {
        if (entry?.prompt) recentImagePromptsBySession.set(sessionId, entry.prompt);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[image] Failed to load prompt state:', error.message);
      }
    }
  }

  function persistRecentImagePrompt(projectId, sessionId, prompt) {
    if ((!projectId && !sessionId) || !prompt) return;
    fs.mkdir(path.dirname(imagePromptState), { recursive: true })
      .then(async () => {
        let state = { version: 1, projects: {}, sessions: {} };
        try {
          state = JSON.parse(await fs.readFile(imagePromptState, 'utf8'));
        } catch {
          // Start fresh.
        }
        state.version = 1;
        if (projectId) {
          state.projects = {
            ...(state.projects || {}),
            [projectId]: { prompt, updatedAt: new Date().toISOString() }
          };
        }
        if (sessionId) {
          state.sessions = {
            ...(state.sessions || {}),
            [sessionId]: { prompt, updatedAt: new Date().toISOString() }
          };
        }
        await fs.writeFile(imagePromptState, JSON.stringify(state, null, 2), 'utf8');
      })
      .catch((error) => console.warn('[image] Failed to persist prompt state:', error.message));
  }

  function rememberImagePrompt(projectId, sessionId, prompt) {
    if (projectId && prompt && isImageRequest(prompt, [])) {
      recentImagePromptsByProject.set(projectId, prompt);
    }
    if (sessionId && prompt && isImageRequest(prompt, [])) {
      recentImagePromptsBySession.set(sessionId, prompt);
    }
    if (prompt && isImageRequest(prompt, [])) {
      persistRecentImagePrompt(projectId, sessionId, prompt);
    }
  }

  function resolveContinuationImagePrompt(projectId, sessionId, message) {
    if (!isContinuationMessage(message)) return '';
    const remembered = sessionId ? recentImagePromptsBySession.get(sessionId) : '';
    if (remembered) return remembered;
    if (!sessionId) return '';
    const sessions = listProjectSessions(projectId);
    const recentImageSession = sessions.find((session) =>
      session.id === sessionId &&
      isImageRequest(session.summary || session.title || '', [])
    );
    return recentImageSession?.summary || recentImageSession?.title || '';
  }

  function resolveImagePrompt({
    enabled,
    projectId,
    sessionId,
    displayMessage,
    attachments,
    forceImage = false,
    skipImage = false
  }) {
    if (!enabled || skipImage) return { prompt: null, intent: null, confidence: 'none' };
    const explicitPrompt = parseExplicitImageCommand(displayMessage);
    if (forceImage || explicitPrompt) {
      const prompt = explicitPrompt || displayMessage;
      const analysis = analyzeImageIntent?.(prompt, attachments) || { intent: null };
      return {
        prompt,
        intent: analysis.intent || (attachments.some((attachment) => attachment.kind === 'image') ? 'edit' : 'generate'),
        confidence: forceImage ? 'forced' : 'explicit-command',
        reason: forceImage ? 'user-confirmed' : 'slash-command'
      };
    }
    const analysis = analyzeImageIntent?.(displayMessage, attachments) || {
      intent: isImageRequest(displayMessage, attachments) ? 'generate' : null,
      confidence: isImageRequest(displayMessage, attachments) ? 'high' : 'none',
      reason: 'legacy'
    };
    if (analysis.intent && analysis.confidence === 'high') {
      return {
        prompt: null,
        intent: analysis.intent,
        confidence: analysis.confidence,
        reason: analysis.reason,
        requiresConfirmation: true
      };
    }
    if (analysis.intent && analysis.confidence === 'medium') {
      return {
        prompt: null,
        intent: analysis.intent,
        confidence: analysis.confidence,
        reason: analysis.reason,
        requiresConfirmation: true
      };
    }
    const continuationPrompt = resolveContinuationImagePrompt(projectId, sessionId, displayMessage);
    return continuationPrompt
      ? { prompt: continuationPrompt, intent: 'generate', confidence: 'continuation', reason: 'current-image-session-continuation' }
      : { prompt: null, intent: null, confidence: 'none', reason: 'no-image-intent' };
  }

  function startImageChat({
    project,
    selectedSessionId,
    conversationSessionId,
    draftSessionId,
    turnId,
    imagePrompt,
    attachments,
    config,
    bridge
  }) {
    const imageSessionId = selectedSessionId || `mobile-image-${crypto.randomUUID()}`;
    rememberImagePrompt(project.id, imageSessionId, imagePrompt);
    const previousSessionId = imageSessionId === conversationSessionId ? draftSessionId : conversationSessionId;
    const imageLabel = attachments.some((attachment) => attachment.kind === 'image') ? '正在编辑图片' : '正在生成图片';
    activeImageRuns.set(turnId, {
      turnId,
      sessionId: imageSessionId,
      previousSessionId,
      startedAt: new Date().toISOString(),
      status: 'running',
      label: imageLabel
    });
    rememberTurn(turnId, {
      projectId: project.id,
      projectPath: project.path,
      sessionId: imageSessionId,
      previousSessionId,
      status: 'running',
      kind: 'image_generation_call',
      label: imageLabel
    });
    runImageTurn(
      {
        sessionId: imageSessionId,
        previousSessionId,
        projectPath: project.path,
        message: imagePrompt,
        attachments,
        config,
        turnId,
        persistMobileSession: true
      },
      (payload) => {
        if (payload.turnId && activeImageRuns.has(payload.turnId)) {
          const existing = activeImageRuns.get(payload.turnId);
          if (payload.type === 'status-update' || payload.type === 'activity-update') {
            activeImageRuns.set(payload.turnId, {
              ...existing,
              sessionId: payload.sessionId || existing.sessionId,
              previousSessionId: payload.previousSessionId || existing.previousSessionId,
              status: payload.status || existing.status,
              label: payload.label || existing.label
            });
          }
        }
        emitJobEvent({ project }, payload);
      }
    ).then(async (finalSessionId) => {
      rememberTurn(turnId, { projectId: project.id, sessionId: finalSessionId, previousSessionId });
      try {
        const snapshot = await refreshCodexCache();
        broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
      } catch (error) {
        console.warn('[sync] Failed to refresh after image chat:', error.message);
      }
    }).catch((error) => {
      const errorMessage = error?.message || '图片生成失败';
      activeImageRuns.delete(turnId);
      rememberTurn(turnId, {
        projectId: project.id,
        sessionId: imageSessionId,
        previousSessionId,
        status: 'failed',
        error: errorMessage,
        label: '图片生成失败'
      });
      emitJobEvent({ project }, {
        type: 'chat-error',
        sessionId: imageSessionId,
        previousSessionId,
        turnId,
        error: errorMessage
      });
    }).finally(() => {
      activeImageRuns.delete(turnId);
    });
    return {
      accepted: true,
      queued: false,
      sessionId: imageSessionId,
      draftSessionId,
      turnId,
      mode: 'image',
      delivery: 'started',
      desktopBridge: bridge
    };
  }

  return { getActiveImageRuns, loadRecentImagePrompts, resolveImagePrompt, startImageChat };
}
