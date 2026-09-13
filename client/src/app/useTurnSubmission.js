// useTurnSubmission — owns the user-facing submit / steer / abort / plan
// handlers and the shared submitCodexMessage core they all funnel through.
// Pulled out of App.jsx as Stage 2 R6.
//
// Pure refactor with one bundled cleanup: handleSubmit and handleVoiceSubmit
// in App.jsx had ~140 lines of dead code after their `return;` statements
// (leftover from an earlier delegation refactor); those unreachable blocks
// are dropped here. Active behavior is unchanged — every code path that ran
// before still runs, with identical inputs to submitCodexMessage / its
// fallbacks.
//
// Lower-level turn machinery (pollTurnUntilComplete, applyTurnSession,
// loadTurnMessages, markRun, clearRun, payloadMatchesCurrentConversation)
// is passed in via options for now. Stage 2 R7 (useTurnRuntime) will move
// those out of App.jsx and into their own hook; useTurnSubmission can then
// receive the whole runtime object instead of individual callbacks.
//
// Returns:
//   submitCodexMessage(opts)     — shared submission core used by handleSubmit /
//                                  handleVoiceSubmit / handleImplementPlan /
//                                  handleAdjustPlan. Builds a draft session if
//                                  needed, posts to /api/chat/send, kicks off
//                                  pollTurnUntilComplete, paints optimistic UI,
//                                  and on error restores composer state and
//                                  surfaces a failed status message (only when
//                                  the user is still on the same session).
//   handleSubmit()               — composer "send" button.
//   handleVoiceSubmit(transcript) — voice transcript → submission. Restores the
//                                   transcript to the input on failure.
//   handleImplementPlan(plan)    — plan card "implement" button. Sends
//                                   "PLEASE IMPLEMENT THIS PLAN:\n…" as
//                                   codexMessage; visible chat message stays
//                                   short ("执行计划"). Dismisses the prompt
//                                   on success.
//   handleAdjustPlan(text, plan?) — plan card "adjust" form submit. Dismisses
//                                   the matching plan-implementation prompt.
//   handleAbort()                — POSTs /api/chat/abort and clears the run.
//   handleSteer(input)           — POSTs /api/chat/steer for the current
//                                   session (drafts are refused locally).

import { apiFetch } from '../api.js';
import {
  completeActivityMessagesForTurn,
  dismissPlanImplementationPrompts,
  upsertStatusMessage
} from '../chat/activity-model.js';
import { selectedSkillsAsBodyEntries } from '../skills/skill-selection.js';
import {
  aliasClientTurnLatency,
  beginClientTurnLatency,
  finishClientTurnLatency,
  markClientTurnLatency
} from '../turn-latency.js';
import {
  createClientTurnId,
  createDraftSession,
  isDraftSession,
  titleFromFirstMessage,
  upsertSessionInProject
} from './session-utils.js';

export function sendModeForRunningFollowup({ running = false, canGuideCurrentTask = false } = {}) {
  if (!running) {
    return null;
  }
  return canGuideCurrentTask ? 'steer' : 'queue';
}

export function useTurnSubmission({
  // composer state
  input,
  attachments,
  selectedSkills = [],
  clearSelectedSkills = () => {},
  planModeActive = false,
  setPlanModeActive = () => {},
  forceImageActive = false,
  setForceImageActive = () => {},
  selectedModel,
  selectedReasoningEffort,
  permissionMode,
  status,
  // session state
  selectedProject,
  selectedProjectRef,
  selectedSession,
  selectedSessionRef,
  running,
  runningById,
  // setters
  setInput,
  setAttachments,
  setSelectedSession,
  setMessages,
  setExpandedProjectIds,
  setSessionsByProject,
  // runtime helpers (App.jsx; R7 will move these into useTurnRuntime)
  markRun,
  clearRun,
  payloadMatchesCurrentConversation,
  pollTurnUntilComplete,
  onQueueChanged,
  onImageConfirmationRequired,
  canGuideCurrentTask = false,
  // constants
  defaultStatus,
  defaultReasoningEffort
}) {
  function restoreVoiceTextToInput(text) {
    const value = String(text || '').trim();
    if (!value) {
      return;
    }
    setInput((current) => {
      const base = String(current || '').trimEnd();
      if (!base) {
        return value;
      }
      if (base.includes(value)) {
        return current;
      }
      return `${base}\n${value}`;
    });
  }

  async function submitCodexMessage({
    message,
    visibleMessage,
    codexMessage: codexMessageOverride,
    attachmentsForTurn = [],
    clearComposer = false,
    restoreTextOnError = false,
    sendMode = null,
    imageMode = null
  }) {
    const project = selectedProject || selectedProjectRef.current;
    const selectedAttachments = Array.isArray(attachmentsForTurn) ? attachmentsForTurn : [];
    const displayMessage = String(visibleMessage || message || '').trim() || (selectedAttachments.length ? '请查看附件。' : '');
    if ((!displayMessage && !selectedAttachments.length) || !project) {
      if (restoreTextOnError && displayMessage) {
        restoreVoiceTextToInput(displayMessage);
      }
      throw new Error(project ? 'message or attachments are required' : '请先选择项目');
    }

    let sessionForTurn = selectedSession;
    if (!sessionForTurn) {
      sessionForTurn = createDraftSession(project);
      setSelectedSession(sessionForTurn);
      setExpandedProjectIds((current) => ({ ...current, [project.id]: true }));
      setSessionsByProject((current) => upsertSessionInProject(current, project.id, sessionForTurn));
    }

    const turnId = createClientTurnId();
    beginClientTurnLatency(turnId);
    const draftSessionId = isDraftSession(sessionForTurn) ? sessionForTurn.id : null;
    const outgoingSessionId = draftSessionId ? null : sessionForTurn?.id || null;
    const optimisticSessionId = draftSessionId || outgoingSessionId || turnId;
    const initialTitle = draftSessionId && !sessionForTurn.titleLocked
      ? titleFromFirstMessage(displayMessage)
      : null;

    if (clearComposer) {
      setInput('');
      setAttachments([]);
      clearSelectedSkills();
      setPlanModeActive(false);
      setForceImageActive(false);
    }

    markRun({ turnId, sessionId: optimisticSessionId, previousSessionId: draftSessionId || outgoingSessionId });
    setSelectedSession((current) =>
      current?.id === sessionForTurn?.id
        ? { ...current, turnId, ...(initialTitle ? { title: initialTitle } : {}) }
        : current
    );
    if (initialTitle) {
      setSessionsByProject((current) => ({
        ...current,
        [project.id]: (current[project.id] || []).map((item) =>
          item.id === sessionForTurn.id ? { ...item, title: initialTitle } : item
        )
      }));
    }
    setMessages((current) =>
      upsertStatusMessage(
        [
          ...current,
          {
            id: `local-${Date.now()}`,
            role: 'user',
            content: displayMessage,
            ...(sendMode === 'steer' ? { guided: true, guideLabel: '已引导对话', kind: 'guided_user' } : {}),
            timestamp: new Date().toISOString(),
            sessionId: optimisticSessionId,
            turnId
          }
        ],
        {
          sessionId: optimisticSessionId,
          turnId,
          kind: 'reasoning',
          status: 'running',
          label: '正在思考中',
          timestamp: new Date().toISOString()
        }
      )
    );

    try {
      const result = await apiFetch('/api/chat/send', {
        method: 'POST',
        body: {
          projectId: project.id,
          sessionId: outgoingSessionId,
          draftSessionId,
          clientTurnId: turnId,
          ...(draftSessionId && sessionForTurn.workingDir ? { workingDir: sessionForTurn.workingDir } : {}),
          message: displayMessage,
          ...(codexMessageOverride ? { codexMessage: codexMessageOverride } : {}),
          permissionMode,
          model: selectedModel || status.model || defaultStatus.model,
          reasoningEffort: selectedReasoningEffort || status.reasoningEffort || defaultReasoningEffort,
          ...(sendMode ? { sendMode } : {}),
          ...(imageMode === 'force' || forceImageActive ? { forceImage: true } : {}),
          ...(imageMode === 'skip' ? { skipImage: true } : {}),
          ...(planModeActive ? { collaborationMode: { mode: 'plan' } } : {}),
          attachments: selectedAttachments,
          selectedSkills: selectedSkillsAsBodyEntries(selectedSkills)
        }
      });
      markClientTurnLatency(turnId, 'sendResponse');
      aliasClientTurnLatency(turnId, result.turnId || turnId);
      if (result.requiresConfirmation && result.confirmationType === 'image-intent') {
        finishClientTurnLatency(turnId, 'confirmation');
        const failKey = { turnId, sessionId: optimisticSessionId, previousSessionId: draftSessionId || outgoingSessionId };
        clearRun(failKey);
        setMessages((current) => current.filter((message) => message.turnId !== turnId));
        onImageConfirmationRequired?.({
          id: turnId,
          message: displayMessage,
          attachments: selectedAttachments,
          sendMode,
          intent: result.intent,
          confidence: result.confidence,
          reason: result.reason,
          prompt: result.message || '要生成图片吗？'
        });
        return {
          requiresConfirmation: true,
          turnId,
          optimisticSessionId,
          projectId: project.id,
          previousSessionId: draftSessionId || outgoingSessionId
        };
      }
      if (result.delivery === 'queued') {
        onQueueChanged?.();
      }
      pollTurnUntilComplete({
        turnId: result.turnId || turnId,
        optimisticSessionId,
        projectId: project.id,
        previousSessionId: draftSessionId || outgoingSessionId
      });
      return {
        turnId: result.turnId || turnId,
        optimisticSessionId,
        projectId: project.id,
        previousSessionId: draftSessionId || outgoingSessionId
      };
    } catch (error) {
      finishClientTurnLatency(turnId, 'send-error');
      const failKey = { turnId, sessionId: optimisticSessionId, previousSessionId: draftSessionId || outgoingSessionId };
      clearRun(failKey);
      if (clearComposer) {
        setAttachments(selectedAttachments);
      }
      if (restoreTextOnError) {
        restoreVoiceTextToInput(displayMessage);
      }
      // Don't paint the send failure into a different conversation if the user
      // moved on while the API call was in flight.
      if (payloadMatchesCurrentConversation(failKey)) {
        setMessages((current) =>
          upsertStatusMessage(current, {
            sessionId: optimisticSessionId,
            turnId,
            kind: 'turn',
            status: 'failed',
            label: '发送失败',
            detail: error.message,
            timestamp: new Date().toISOString()
          })
        );
      }
      throw error;
    }
  }

  async function handleSubmit({ mode = 'start' } = {}) {
    const message = input.trim();
    if ((!message && !attachments.length) || !selectedProject) {
      return;
    }
    try {
      await submitCodexMessage({
        message,
        attachmentsForTurn: attachments,
        clearComposer: true,
        sendMode: running ? mode : null
      });
      onQueueChanged?.();
    } catch {
      // submitCodexMessage already reflects the failure in the chat UI.
    }
  }

  async function handleVoiceSubmit(transcript) {
    const message = String(transcript || '').trim();
    if (!message) {
      throw new Error('没有识别到文字');
    }
    return submitCodexMessage({
      message,
      attachmentsForTurn: [],
      restoreTextOnError: true
    });
  }

  async function handleImplementPlan(planImplementation) {
    const planContent = String(planImplementation?.planContent || '').trim();
    if (!planContent) {
      return false;
    }
    const codexMessage = `PLEASE IMPLEMENT THIS PLAN:\n${planContent}`;
    try {
      await submitCodexMessage({
        message: '执行计划',
        codexMessage,
        clearComposer: false,
        sendMode: sendModeForRunningFollowup({ running, canGuideCurrentTask })
      });
      setMessages((current) => dismissPlanImplementationPrompts(current, planImplementation));
      return true;
    } catch {
      return false;
    }
  }

  async function handleAdjustPlan(message, planImplementation = null) {
    const text = String(message || '').trim();
    if (!text) {
      return false;
    }
    try {
      await submitCodexMessage({
        message: text,
        clearComposer: false,
        sendMode: sendModeForRunningFollowup({ running, canGuideCurrentTask })
      });
      if (planImplementation) {
        setMessages((current) => dismissPlanImplementationPrompts(current, planImplementation));
      }
      return true;
    } catch {
      return false;
    }
  }

  async function handleAbort() {
    const currentSession = selectedSessionRef.current;
    const runningKey = Object.keys(runningById || {})[0] || '';
    const turnId = currentSession?.turnId || runningKey || null;
    const sessionId = currentSession?.id || runningKey || null;
    if (!turnId && !sessionId) {
      return;
    }
    const completedAt = new Date().toISOString();
    const abortPayload = {
      sessionId,
      turnId,
      previousSessionId: currentSession?.previousSessionId || null,
      completedAt,
      timestamp: completedAt
    };
    try {
      await apiFetch('/api/chat/abort', {
        method: 'POST',
        body: {
          projectId: currentSession?.projectId || selectedProjectRef.current?.id || selectedProject?.id || null,
          sessionId,
          turnId,
          previousSessionId: currentSession?.previousSessionId || null
        }
      });
    } catch (error) {
      setMessages((current) =>
        upsertStatusMessage(current, {
          ...abortPayload,
          kind: 'turn',
          status: 'failed',
          label: '中止失败',
          detail: error.message || '后端没有确认中止，请检查桌面端或后台任务状态。',
          timestamp: new Date().toISOString()
        })
      );
      return;
    }
    clearRun(abortPayload);
    setMessages((current) =>
      upsertStatusMessage(
        completeActivityMessagesForTurn(current, abortPayload),
        {
          ...abortPayload,
          kind: 'turn',
          status: 'completed',
          label: '已中止',
          completedAt,
          timestamp: completedAt
        }
      )
    );
  }

  async function handleSteer(steerInput) {
    const sessionId = selectedSessionRef.current?.id;
    const text = String(steerInput || '').trim();
    if (!sessionId || sessionId.startsWith('draft-') || !text) return;
    try {
      await apiFetch('/api/chat/steer', {
        method: 'POST',
        body: { sessionId, input: text }
      });
      setInput('');
    } catch (error) {
      window.alert(`插话失败：${error.message}`);
    }
  }

  return {
    submitCodexMessage,
    handleSubmit,
    handleVoiceSubmit,
    handleImplementPlan,
    handleAdjustPlan,
    handleAbort,
    handleSteer,
    restoreVoiceTextToInput
  };
}
