import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, getToken, setToken, websocketUrl } from './api.js';
import { agentMeta } from './agent-meta.js';
import { Composer } from './composer/Composer.jsx';
import { ConnectionRecoveryCard } from './panels/ConnectionRecoveryCard.jsx';
import { UpdateBanner } from './panels/UpdateBanner.jsx';
import { currentBuildId } from './build-id.js';
import { SkillPicker } from './skills/SkillPicker.jsx';
import { useSkillCatalog } from './skills/useSkillCatalog.js';
import { useClaudeSlashCommands } from './app/useClaudeSlashCommands.js';
import { DocsPanel } from './panels/DocsPanel.jsx';
import { Drawer } from './panels/Drawer.jsx';
import { WorktreePicker } from './panels/WorktreePicker.jsx';
import { PairingScreen } from './panels/PairingScreen.jsx';
import { TopBar } from './panels/TopBar.jsx';
import { DEFAULT_STATUS } from './app/default-status.js';
import {
  activityStepFromPayload,
  briefActivityLabel,
  completeStatusMessage,
  upsertActivityMessage,
  upsertAssistantMessage,
  upsertStatusMessage
} from './chat/activity-model.js';
import { ChatPane } from './chat/ChatPane.jsx';
import { ImagePreviewModal } from './chat/ImagePreviewModal.jsx';
import { VoiceDialogPanel } from './chat/VoiceDialogPanel.jsx';
import { connectionRecoveryState } from './connection-recovery.js';
import {
  preferredProjectFromStoredSelection,
  readStoredSelection,
  rememberSelectedSession,
  selectedSessionFromStoredSelection
} from './selection-persistence.js';
import { canGuideCurrentTask as canGuideCurrentTaskForSend } from './runtime-capabilities.js';
import { useAppBootstrap } from './app/useAppBootstrap.js';
import { useAppWebSocket } from './app/useAppWebSocket.js';
import ApprovalSheet from './ApprovalSheet.jsx';
import { useFileUploads } from './app/useFileUploads.js';
import { useSessionActions } from './app/useSessionActions.js';
import { useSessionLivePolling } from './app/useSessionLivePolling.js';
import { DEFAULT_REASONING_EFFORT, useThemePrefs } from './app/useThemePrefs.js';
import { useMessageActions } from './app/useMessageActions.js';
import { useConnectionActions } from './app/useConnectionActions.js';
import { useCompactAction } from './app/useCompactAction.js';
import { useImageIntentResolver } from './app/useImageIntentResolver.js';
import {
  createClientTurnId,
  createDraftSession,
  isDraftSession,
  titleFromFirstMessage,
  upsertSessionInProject
} from './app/session-utils.js';
import { useQueueDrafts } from './composer/useQueueDrafts.js';
import { useDesktopBridge } from './app/useDesktopBridge.js';
import { useDocsActions } from './app/useDocsActions.js';
import { usePinActions } from './app/usePinActions.js';
import { useTurnRuntime } from './app/useTurnRuntime.js';
import { useVoiceDialog } from './app/useVoiceDialog.js';
import { useTurnSubmission } from './app/useTurnSubmission.js';
import { useViewportSizing } from './app/useViewportSizing.js';
import NotificationSettings from './notifications.jsx';
import { ActivityPanel } from './panels/ActivityPanel.jsx';
import GitPanel from './git-panel.jsx';

const modalBackdropStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 90, padding: 12
};
const modalShellStyle = {
  background: 'var(--panel)', borderRadius: 14, maxWidth: 640, width: '100%',
  maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 50px rgba(0,0,0,0.25)'
};

function selectedRunKeys(session) {
  return [session?.id, session?.turnId].filter(Boolean);
}

function hasRunningKey(runningById, keys) {
  return keys.some((key) => Boolean(runningById[key]));
}


export default function App() {
  const [status, setStatus] = useState(DEFAULT_STATUS);
  const [authenticated, setAuthenticated] = useState(Boolean(getToken()));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [projects, setProjects] = useState([]);
  const [pinFolders, setPinFolders] = useState([]);
  const [pinnedSessions, setPinnedSessions] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState({});
  const [sessionsByProject, setSessionsByProject] = useState({});
  const [loadingProjectId, setLoadingProjectId] = useState(null);
  const [selectedSession, setSelectedSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [approvalRequests, setApprovalRequests] = useState([]);

  const pushApprovalRequest = (request) => {
    setApprovalRequests((current) => {
      // Dedup by requestId — the server may reissue if the same prompt times
      // out and the next turn revives it; we never want two sheet entries
      // sharing an id.
      if (current.some((r) => r.requestId === request.requestId)) return current;
      return [...current, request];
    });
  };
  const dropApprovalRequest = (matcher) => {
    setApprovalRequests((current) =>
      current.filter((r) => {
        if (matcher?.requestId) return r.requestId !== matcher.requestId;
        if (matcher?.turnId) return r.turnId !== matcher.turnId;
        return true;
      })
    );
  };
  const respondToApproval = (requestId, decision) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'approval-response', requestId, ...decision }));
    }
    dropApprovalRequest({ requestId });
  };
  const [previewImage, setPreviewImage] = useState(null);
  const [imageIntentConfirmation, setImageIntentConfirmation] = useState(null);
  const [docsOpen, setDocsOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  // Peer CodexMobile servers (claude side from codex, etc.). Fetched once
  // on auth; empty list when CODEXMOBILE_PEER_URLS is unset.
  const [peers, setPeers] = useState([]);
  const [docsBusy, setDocsBusy] = useState(false);
  const [docsError, setDocsError] = useState('');
  // Composer draft survives an iOS PWA kill/reload — the OS reclaims frozen
  // pages aggressively, and losing a half-typed prompt is the worst way to
  // find out. Cleared on send (setInput('')) via the persistence effect below.
  const [input, setInput] = useState(
    () => localStorage.getItem('codexmobile.composerDraft') || ''
  );
  const [permissionMode, setPermissionMode] = useState(
    () => localStorage.getItem('codexmobile.permissionMode') || 'bypassPermissions'
  );
  const [selectedModel, setSelectedModel] = useState(null);
  const { theme, setTheme, selectedReasoningEffort, setSelectedReasoningEffort } =
    useThemePrefs({ statusReasoningEffort: status.reasoningEffort });
  const [connectionState, setConnectionState] = useState(() => (getToken() ? 'connecting' : 'disconnected'));
  useEffect(() => {
    localStorage.setItem('codexmobile.permissionMode', permissionMode);
  }, [permissionMode]);
  useEffect(() => {
    // Debounced so mobile typing doesn't hit localStorage on every keystroke.
    const timer = window.setTimeout(() => {
      if (input) {
        localStorage.setItem('codexmobile.composerDraft', input);
      } else {
        localStorage.removeItem('codexmobile.composerDraft');
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [input]);
  const wsRef = useRef(null);
  const selectedProjectRef = useRef(null);
  const selectedSessionRef = useRef(null);
  const sessionsByProjectRef = useRef({});
  const {
    attachments,
    setAttachments,
    uploading,
    handleUploadFiles,
    handleRemoveAttachment
  } = useFileUploads({ selectedSessionRef, setMessages });
  const {
    queueDrafts,
    loadQueueDrafts,
    removeQueueDraft,
    restoreQueueDraft,
    steerQueueDraft
  } = useQueueDrafts({
    selectedSessionRef,
    selectedProjectRef,
    selectedProject,
    setInput,
    setAttachments
  });

  useViewportSizing();

  const {
    runningById,
    markRun,
    clearRun,
    payloadMatchesCurrentConversation,
    syncActiveRunsFromStatus,
    markTurnCompleted,
    scheduleTurnRefresh,
    pollTurnUntilComplete
  } = useTurnRuntime({
    selectedSessionRef,
    setMessages,
    setSelectedSession,
    setSessionsByProject
  });

  const running =
    hasRunningKey(runningById, selectedRunKeys(selectedSession)) ||
    messages.some((message) => message.role === 'activity' && (message.status === 'running' || message.status === 'queued'));



  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  useEffect(() => {
    sessionsByProjectRef.current = sessionsByProject;
  }, [sessionsByProject]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }
    loadQueueDrafts(selectedSession);
  }, [authenticated, selectedSession?.id, loadQueueDrafts]);

  useEffect(() => {
    // Fetch sibling CodexMobile servers on auth + every (re)connect. The
    // list itself is static (env-driven), but the running server process
    // doesn't expose it until it boots — refetching when the WS reaches
    // 'connected' picks up a peer URL the user added to .env after the
    // PWA already mounted (e.g. they restart the server, the WS reconnects,
    // and the top-bar dropdown appears without a hard refresh).
    if (!authenticated || connectionState !== 'connected') return undefined;
    let cancelled = false;
    apiFetch('/api/peers')
      .then((data) => {
        if (cancelled) return;
        setPeers(Array.isArray(data?.peers) ? data.peers : []);
      })
      .catch(() => { /* peers stay empty — no top-bar dropdown */ });
    return () => { cancelled = true; };
  }, [authenticated, connectionState]);

  // Honour the cross-server deep-link URL: ?session=<id> means a peer
  // CodexMobile (or someone sharing a link) wants the chat to open that
  // session directly. Wait until projects are loaded so we can find the
  // session's project from its cwd; consume the param exactly once
  // (replaceState) so a manual refresh doesn't re-trigger.
  const deepLinkSessionId = useMemo(() => {
    if (typeof window === 'undefined') return null;
    try {
      const params = new URLSearchParams(window.location.search);
      const id = params.get('session');
      return id && id.trim() ? id.trim() : null;
    } catch {
      return null;
    }
  }, []);
  const deepLinkAppliedRef = useRef(false);
  useEffect(() => {
    if (!authenticated) return;
    if (!deepLinkSessionId) return;
    if (deepLinkAppliedRef.current) return;
    if (!projects || projects.length === 0) return;
    deepLinkAppliedRef.current = true;
    apiFetch(`/api/sessions/${encodeURIComponent(deepLinkSessionId)}/files?limit=1`)
      .then((data) => {
        const cwd = String(data?.cwd || '').replace(/\\/g, '/').toLowerCase();
        const matched = cwd
          ? projects.find((p) => String(p.path || '').replace(/\\/g, '/').toLowerCase() === cwd)
          : null;
        setSelectedSession({
          id: deepLinkSessionId,
          projectId: matched?.id || null,
          title: ''
        });
      })
      .catch(() => {
        // Session unknown on this server — silently ignore. The user
        // probably arrived from a peer URL but pasted an id that lives
        // on yet another server.
      })
      .finally(() => {
        // Strip ?session= so a manual refresh doesn't replay.
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete('session');
          window.history.replaceState(null, '', url.toString());
        } catch { /* noop */ }
      });
  }, [authenticated, deepLinkSessionId, projects, setSelectedSession]);




  useEffect(() => {
    if (status.model && !selectedModel) {
      setSelectedModel(status.model);
    }
  }, [selectedModel, status.model]);


  const {
    loadSessions,
    handleOpenProject,
    handleToggleProject,
    handleSelectSession,
    handleRenameSession,
    handleDeleteSession,
    handleArchiveProject,
    handleRestoreProject
  } = useSessionActions({
    selectedProject,
    selectedProjectRef,
    selectedSessionRef,
    expandedProjectIds,
    sessionsByProject,
    setSelectedProject,
    setSelectedSession,
    setSessionsByProject,
    setMessages,
    setExpandedProjectIds,
    setLoadingProjectId,
    setProjects,
    setPinFolders,
    setDrawerOpen,
    setAttachments,
    setInput
  });

  const {
    loadStatus,
    loadProjects,
    loadPinnedSessions,
    bootstrap,
    syncing,
    handleSync
  } = useAppBootstrap({
    setStatus,
    setAuthenticated,
    setProjects,
    setPinFolders,
    setPinnedSessions,
    setSelectedProject,
    setSessionsByProject,
    setExpandedProjectIds,
    selectedProjectRef,
    syncActiveRunsFromStatus,
    loadSessions
  });

  const {
    desktopBridge,
    setDesktopBridge,
    runtimePrefsState,
    handleSetRuntimePref
  } = useDesktopBridge({ authenticated });

  const {
    availableSkills,
    selectedSkills,
    setSelectedSkills,
    clearSelectedSkills,
    refreshSkills
  } = useSkillCatalog({ authenticated });
  const { claudeSlashCommands, refreshClaudeSlashCommands } = useClaudeSlashCommands({
    authenticated,
    agentId: agentMeta(status).id,
    projectId: selectedProject?.id || null
  });
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [planModeActive, setPlanModeActive] = useState(false);
  const [forceImageActive, setForceImageActive] = useState(false);

  useAppWebSocket({
    authenticated,
    defaultStatus: DEFAULT_STATUS,
    wsRef,
    selectedProjectRef,
    selectedSessionRef,
    sessionsByProjectRef,
    setConnectionState,
    setStatus,
    setSelectedSession,
    setSessionsByProject,
    setMessages,
    setProjects,
    setPinFolders,
    setPinnedSessions,
    setDesktopBridge,
    syncActiveRunsFromStatus,
    markRun,
    clearRun,
    markTurnCompleted,
    scheduleTurnRefresh,
    payloadMatchesCurrentConversation,
    upsertSessionInProject,
    upsertStatusMessage,
    upsertActivityMessage,
    upsertAssistantMessage,
    briefActivityLabel,
    pushApprovalRequest,
    dropApprovalRequest,
    onQueueUpdated: loadQueueDrafts
  });

  useSessionLivePolling({
    authenticated,
    selectedSession,
    selectedSessionRef,
    running,
    desktopBridge,
    setMessages
  });

  const {
    handleRetryConnection,
    handleResetPairing,
    handleShowConnectionStatus
  } = useConnectionActions({
    connectionState,
    desktopBridge,
    provider: status?.provider,
    loadStatus,
    setConnectionState,
    setAuthenticated
  });


  const {
    handleTogglePin,
    handleMoveSessionToFolder,
    handleCreatePinFolder,
    handleRenamePinFolder,
    handleToggleFolderCollapsed,
    handleDeletePinFolder,
    handlePromptMoveToFolder
  } = usePinActions({
    pinFolders,
    selectedProjectRef,
    sessionsByProject,
    setPinFolders,
    setSessionsByProject,
    setSelectedSession,
    loadPinnedSessions
  });

  const { beginConversation, handleDeleteMessage } = useMessageActions({
    selectedProject,
    projects,
    selectedSessionRef,
    messages,
    setSelectedProject,
    setSelectedSession,
    setExpandedProjectIds,
    setSessionsByProject,
    setMessages,
    setAttachments,
    setDrawerOpen
  });

  // New-conversation orchestration: if the target project is a git repo with
  // more than one worktree, pop the picker first; otherwise (single worktree /
  // non-repo / fetch failure) start the draft in the project root directly.
  const [worktreePicker, setWorktreePicker] = useState(null);
  const handleNewConversation = useCallback(async () => {
    const project = selectedProject || projects[0];
    if (!project) {
      return;
    }
    try {
      const data = await apiFetch(`/api/git/worktrees?projectId=${encodeURIComponent(project.id)}`);
      const list = Array.isArray(data?.worktrees) ? data.worktrees : [];
      if (list.length > 1) {
        setWorktreePicker({ project, worktrees: list });
        return;
      }
    } catch {
      // Not a git repo, or the lookup failed — fall through to the project root.
    }
    beginConversation(project);
  }, [selectedProject, projects, beginConversation]);

  const handlePickWorktree = useCallback((worktree) => {
    if (worktreePicker?.project) {
      beginConversation(worktreePicker.project, {
        workingDir: worktree?.path || null,
        workingBranch: worktree?.branch || null
      });
    }
    setWorktreePicker(null);
  }, [worktreePicker, beginConversation]);

  const { handleCompact } = useCompactAction({
    selectedSessionRef,
    selectedProjectRef,
    selectedProject,
    setMessages
  });


  const canGuideCurrentTask = canGuideCurrentTaskForSend({
    agentId: agentMeta(status).id,
    running,
    selectedSessionId: selectedSession?.id || '',
    sessionIsDraft: isDraftSession(selectedSession),
    desktopBridge
  });

  const {
    submitCodexMessage,
    handleSubmit,
    handleVoiceSubmit,
    handleImplementPlan,
    handleAdjustPlan,
    handleAbort,
    handleSteer,
    restoreVoiceTextToInput
  } = useTurnSubmission({
    input,
    attachments,
    selectedSkills,
    clearSelectedSkills,
    planModeActive,
    setPlanModeActive,
    forceImageActive,
    setForceImageActive,
    selectedModel,
    selectedReasoningEffort,
    permissionMode,
    status,
    selectedProject,
    selectedProjectRef,
    selectedSession,
    selectedSessionRef,
    running,
    runningById,
    setInput,
    setAttachments,
    setSelectedSession,
    setMessages,
    setExpandedProjectIds,
    setSessionsByProject,
    markRun,
    clearRun,
    payloadMatchesCurrentConversation,
    pollTurnUntilComplete,
    onQueueChanged: () => loadQueueDrafts(selectedSessionRef.current),
    onImageConfirmationRequired: setImageIntentConfirmation,
    canGuideCurrentTask,
    defaultStatus: DEFAULT_STATUS,
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT
  });

  const { handleResolveImageIntent } = useImageIntentResolver({
    imageIntentConfirmation,
    selectedSessionRef,
    setImageIntentConfirmation,
    setInput,
    setAttachments,
    submitCodexMessage,
    loadQueueDrafts
  });

  const {
    voiceDialogOpen,
    voiceDialogState,
    voiceDialogError,
    voiceDialogTranscript,
    voiceDialogAssistantText,
    voiceDialogHandoffDraft,
    openVoiceDialog,
    closeVoiceDialog,
    startVoiceDialogRecording,
    stopVoiceDialogRecording,
    setVoiceDialogHandoffDraftValue,
    submitVoiceHandoffToCodex,
    continueVoiceHandoffCollection,
    cancelVoiceHandoffConfirmation
  } = useVoiceDialog({
    status,
    messages,
    runningById,
    selectedProject,
    selectedProjectRef,
    submitCodexMessage,
    handleVoiceSubmit
  });

  const {
    handleConnectDocs,
    handleDisconnectDocs,
    handleRefreshDocs,
    handleOpenDocsHome,
    handleOpenDocsAuth
  } = useDocsActions({
    docsBusy,
    status,
    setDocsBusy,
    setDocsError,
    setStatus,
    loadStatus
  });

  const shellClass = useMemo(() => (drawerOpen ? 'app-shell drawer-active' : 'app-shell'), [drawerOpen]);
  const recoveryState = useMemo(() => connectionRecoveryState({
    authenticated,
    connectionState,
    syncing
  }), [authenticated, connectionState, syncing]);
  const clientBuildId = useMemo(() => currentBuildId(), []);
  const updateAvailable = Boolean(clientBuildId && status?.buildId && status.buildId !== clientBuildId);

  if (!authenticated) {
    return <PairingScreen onPaired={bootstrap} initialStatus={status} />;
  }

  return (
    <div className={shellClass}>
      <TopBar
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        connectionState={connectionState}
        status={status}
        desktopBridge={desktopBridge}
        peers={peers}
        onMenu={() => setDrawerOpen(true)}
        onOpenDocs={() => setDocsOpen(true)}
        onShowConnectionStatus={handleShowConnectionStatus}
      />
      <ConnectionRecoveryCard
        state={recoveryState}
        onRetry={handleRetryConnection}
        onSync={handleSync}
        onPair={handleResetPairing}
        onStatus={handleShowConnectionStatus}
      />
      {!recoveryState && updateAvailable ? (
        <UpdateBanner onReload={() => window.location.reload()} />
      ) : null}
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        projects={projects}
        pinFolders={pinFolders}
        pinnedSessions={pinnedSessions}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        expandedProjectIds={expandedProjectIds}
        sessionsByProject={sessionsByProject}
        loadingProjectId={loadingProjectId}
        onToggleProject={handleToggleProject}
        onSelectProject={handleOpenProject}
        onSelectSession={handleSelectSession}
        onRenameSession={handleRenameSession}
        onDeleteSession={handleDeleteSession}
        onArchiveProject={handleArchiveProject}
        onRestoreProject={handleRestoreProject}
        onTogglePin={handleTogglePin}
        onMoveSessionToFolder={handlePromptMoveToFolder}
        onCreatePinFolder={handleCreatePinFolder}
        onRenamePinFolder={handleRenamePinFolder}
        onDeletePinFolder={handleDeletePinFolder}
        onToggleFolderCollapsed={handleToggleFolderCollapsed}
        onNewConversation={handleNewConversation}
        onSync={handleSync}
        onOpenGit={() => { setGitOpen(true); setDrawerOpen(false); }}
        onOpenNotifications={() => { setNotificationsOpen(true); setDrawerOpen(false); }}
        onOpenActivity={() => { setActivityOpen(true); setDrawerOpen(false); }}
        onShowConnectionStatus={handleShowConnectionStatus}
        peers={peers}
        syncing={syncing}
        theme={theme}
        setTheme={setTheme}
        status={status}
        desktopBridge={desktopBridge}
        runtimePrefs={runtimePrefsState}
        onSetRuntimePref={handleSetRuntimePref}
      />
      <DocsPanel
        open={docsOpen}
        docs={status.docs}
        busy={docsBusy}
        error={docsError}
        onClose={() => setDocsOpen(false)}
        onConnect={handleConnectDocs}
        onDisconnect={handleDisconnectDocs}
        onOpenHome={handleOpenDocsHome}
        onOpenAuth={handleOpenDocsAuth}
        onRefresh={handleRefreshDocs}
      />
      {gitOpen && selectedProject ? (
        <div style={modalBackdropStyle} onClick={() => setGitOpen(false)}>
          <div style={modalShellStyle} onClick={(e) => e.stopPropagation()}>
            <GitPanel
              project={selectedProject}
              peers={peers}
              currentAgent={agentMeta(status).id}
              onClose={() => setGitOpen(false)}
              onInsertIntoComposer={(text) => {
                setInput((current) => (current ? `${current}\n${text}` : text));
                setGitOpen(false);
              }}
              onSelectSession={(session) => {
                // The session may have run in a different project than the
                // one currently selected (two clones of the same repo, an
                // old worktree, shared file referenced from multiple
                // projects). Look up its cwd against the projects list so
                // the chat opens scoped correctly. Win32 + mixed-slash
                // paths compared case-insensitively after collapse.
                const cwd = String(session?.cwd || '').replace(/\\/g, '/').toLowerCase();
                const matched = cwd
                  ? projects.find((p) => String(p.path || '').replace(/\\/g, '/').toLowerCase() === cwd)
                  : null;
                setSelectedSession({
                  id: session.sessionId,
                  projectId: matched?.id || selectedProject?.id,
                  title: ''
                });
                setGitOpen(false);
              }}
            />
          </div>
        </div>
      ) : null}
      {notificationsOpen ? (
        <div style={modalBackdropStyle} onClick={() => setNotificationsOpen(false)}>
          <div style={modalShellStyle} onClick={(e) => e.stopPropagation()}>
            <NotificationSettings />
            <div className="modal-close-row">
              <button type="button" className="settings-entry" onClick={() => setNotificationsOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      ) : null}
      {activityOpen ? (
        <ActivityPanel onClose={() => setActivityOpen(false)} />
      ) : null}
      <ChatPane
        messages={messages}
        selectedSession={selectedSession}
        running={running}
        agent={agentMeta(status)}
        onPreviewImage={setPreviewImage}
        onDeleteMessage={handleDeleteMessage}
        onUseSuggestion={(suggestion) => setInput(suggestion)}
        onImplementPlan={handleImplementPlan}
        onAdjustPlan={handleAdjustPlan}
      />
      <VoiceDialogPanel
        open={voiceDialogOpen}
        state={voiceDialogState}
        error={voiceDialogError}
        transcript={voiceDialogTranscript}
        assistantText={voiceDialogAssistantText}
        handoffDraft={voiceDialogHandoffDraft}
        onHandoffDraftChange={setVoiceDialogHandoffDraftValue}
        onHandoffSubmit={submitVoiceHandoffToCodex}
        onHandoffContinue={continueVoiceHandoffCollection}
        onHandoffCancel={cancelVoiceHandoffConfirmation}
        onStart={startVoiceDialogRecording}
        onStop={stopVoiceDialogRecording}
        onClose={closeVoiceDialog}
        agent={agentMeta(status)}
      />
      <Composer
        input={input}
        setInput={setInput}
        onSubmit={handleSubmit}
        running={running}
        onAbort={handleAbort}
        onSteer={handleSteer}
        models={status.models}
        selectedModel={selectedModel}
        onSelectModel={setSelectedModel}
        selectedReasoningEffort={selectedReasoningEffort}
        onSelectReasoningEffort={setSelectedReasoningEffort}
        permissionMode={permissionMode}
        onSelectPermission={setPermissionMode}
        attachments={attachments}
        onUploadFiles={handleUploadFiles}
        onRemoveAttachment={handleRemoveAttachment}
        uploading={uploading}
        onVoiceSubmit={handleVoiceSubmit}
        onOpenVoiceDialog={openVoiceDialog}
        voiceDialogActive={voiceDialogOpen}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        onCompact={handleCompact}
        connectionState={connectionState}
        desktopBridge={desktopBridge}
        status={status}
        queueDrafts={queueDrafts}
        onRemoveQueueDraft={removeQueueDraft}
        onRestoreQueueDraft={restoreQueueDraft}
        onSteerQueueDraft={steerQueueDraft}
        imageIntentConfirmation={imageIntentConfirmation}
        onResolveImageIntent={handleResolveImageIntent}
        availableSkills={availableSkills}
        selectedSkills={selectedSkills}
        onChangeSelectedSkills={setSelectedSkills}
        onOpenSkillPicker={() => {
          // Re-fetch on open: a resident iOS PWA never re-runs the boot-time
          // catalog load, so skills installed after launch stay invisible.
          refreshSkills();
          setSkillPickerOpen(true);
        }}
        agentId={agentMeta(status).id}
        claudeSlashCommands={claudeSlashCommands}
        onSlashPickerOpen={refreshClaudeSlashCommands}
        planModeActive={planModeActive}
        onTogglePlanMode={setPlanModeActive}
        forceImageActive={forceImageActive}
        onToggleForceImage={setForceImageActive}
      />
      <SkillPicker
        open={skillPickerOpen}
        availableSkills={availableSkills}
        selectedSkills={selectedSkills}
        onChange={setSelectedSkills}
        onClose={() => setSkillPickerOpen(false)}
      />
      <ImagePreviewModal image={previewImage} onClose={() => setPreviewImage(null)} />
      <WorktreePicker
        open={Boolean(worktreePicker)}
        projectName={worktreePicker?.project?.name || ''}
        worktrees={worktreePicker?.worktrees || []}
        onSelect={handlePickWorktree}
        onClose={() => setWorktreePicker(null)}
      />
      <ApprovalSheet requests={approvalRequests} onRespond={respondToApproval} />
    </div>
  );
}
