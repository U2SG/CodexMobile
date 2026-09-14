// Project / session drawer. Houses the new-conversation button, pinned
// sessions (delegated to PinnedSection), grouped project + thread list,
// direct conversation sync, the single-account Codex quota view, Git /
// settings / notifications entry points, and the theme preferences sub-view.
//
// Extracted from App.jsx (Batch G R23). All inputs flow in as props. The
// Codex quota fetch is owned here (it's only consumed by this panel); the
// per-row stopThreadAction helper, quota formatting helpers, and project-group
// renderer are all module-private since no other consumer needs them.

import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Folder,
  GitBranch,
  Loader2,
  Plus,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Trash2,
  Wifi,
  X
} from 'lucide-react';
import { apiFetch } from '../api.js';
import { agentMeta, isClaudeProvider } from '../agent-meta.js';
import { CopyResumeButton } from '../chat/CopyResumeButton.jsx';
import { formatTime } from '../format-time.js';
import { compactPath } from '../utils/path.js';
import { PinnedSection } from './PinnedSection.jsx';
import { classifyDrawerProjects, projectMatchesQuery } from './project-visibility.js';

function stopThreadAction(event, action) {
  event.preventDefault();
  event.stopPropagation();
  action();
}

function quotaPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) {
    return null;
  }
  return Math.max(0, Math.min(100, percent));
}

function quotaRemainingPercent(quotaWindow) {
  if (!quotaWindow || typeof quotaWindow !== 'object') {
    return null;
  }
  const display = quotaPercent(quotaWindow.displayPercent ?? quotaWindow.display_percent);
  if (display !== null) {
    return display;
  }
  const explicit = quotaPercent(quotaWindow.remainingPercent ?? quotaWindow.remaining_percent);
  if (explicit !== null) {
    return explicit;
  }
  const used = quotaPercent(quotaWindow.usedPercent ?? quotaWindow.used_percent);
  return used === null ? null : Math.max(0, Math.min(100, 100 - used));
}

function formatQuotaPercent(quotaWindow) {
  const percent = quotaRemainingPercent(quotaWindow);
  return percent === null ? '--' : `${Math.round(percent)}%`;
}

function formatQuotaResetAbsolute(value) {
  if (!value) {
    return '';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function formatQuotaReset(quotaWindow) {
  if (!quotaWindow || typeof quotaWindow !== 'object') {
    return '';
  }
  const resetAtMs = Number(quotaWindow.resetAtMs ?? quotaWindow.reset_at_ms ?? 0);
  const absoluteValue =
    quotaWindow.resetAtLabel ??
    quotaWindow.reset_at_label ??
    (Number.isFinite(resetAtMs) && resetAtMs > 0 ? resetAtMs : (quotaWindow.resetAt ?? quotaWindow.reset_at ?? ''));
  const absolute = formatQuotaResetAbsolute(absoluteValue);
  const relative = quotaWindow.resetLabel ?? quotaWindow.reset_label ?? '';
  if (absolute && relative) {
    return `到期 ${absolute} · ${relative}`;
  }
  if (absolute) {
    return `到期 ${absolute}`;
  }
  if (relative) {
    return `剩余 ${relative}`;
  }
  return '';
}

function quotaToneClass(percent) {
  if (percent === null) {
    return 'is-low';
  }
  if (percent >= 80) {
    return 'is-healthy';
  }
  if (percent >= 60) {
    return 'is-medium';
  }
  if (percent >= 40) {
    return 'is-warning';
  }
  return 'is-low';
}

function renderProjectGroup({
  project,
  selectedProject,
  expandedProjectIds,
  sessionsByProject,
  loadingProjectId,
  selectedSession,
  agent,
  onToggleProject,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onArchiveProject,
  onTogglePin,
  openThreadIds
}) {
  const isSelected = selectedProject?.id === project.id;
  const isExpanded = Boolean(expandedProjectIds[project.id]);
  // Defensive dedup: if a transient race in state ever produces two entries
  // with the same id, render only the first. Prevents React duplicate-key
  // warnings and the visual "two rows for one session" symptom.
  const projectSessions = (() => {
    const seen = new Set();
    const out = [];
    for (const session of sessionsByProject[project.id] || []) {
      if (!session?.id || seen.has(session.id)) continue;
      seen.add(session.id);
      out.push(session);
    }
    return out;
  })();
  return (
    <div key={project.id} className="project-group">
      <div
        className={`project-row ${isSelected ? 'is-selected' : ''} ${isExpanded ? 'is-expanded' : ''}`}
        title={`${project.name}${project.path ? `\n${project.path}` : ''}`}
      >
        <button
          type="button"
          className="project-main"
          onClick={() => onToggleProject(project)}
          aria-label={`${project.name}${project.path ? ` ${project.path}` : ''}`}
        >
          <Folder size={18} />
          <span>
            <strong title={project.name}>{project.name}</strong>
            <small title={project.path}>{compactPath(project.path)}</small>
          </span>
        </button>
        <small className="project-count">{project.sessionCount || projectSessions.length || 0}</small>
        {onArchiveProject ? (
          <button
            type="button"
            className="project-archive"
            onClick={(event) => stopThreadAction(event, async () => {
              await onArchiveProject(project);
            })}
            aria-label="归档项目"
            title="归档项目"
          >
            <Archive size={15} />
          </button>
        ) : null}
        <ChevronDown size={15} className="project-chevron" />
      </div>
      {isExpanded ? (
        <div className="thread-list">
          {loadingProjectId === project.id ? (
            <div className="thread-empty">
              <Loader2 className="spin" size={14} />
              加载中
            </div>
          ) : projectSessions.length ? (
            projectSessions.map((session) => (
              <div
                key={session.id}
                className={`thread-row ${selectedSession?.id === session.id ? 'is-selected' : ''} ${session.draft ? 'is-draft' : ''} ${session.pinned ? 'is-pinned' : ''} ${onTogglePin && !session.draft ? 'has-pin-action' : ''} ${openThreadIds?.has(session.id) ? 'is-desktop-live' : ''}`}
              >
                <button
                  type="button"
                  className="thread-main"
                  onClick={() => onSelectSession(session)}
                >
                  <span>
                    {session.pinned ? <Pin size={12} className="thread-pin-indicator" /> : null}
                    {session.title || '对话'}
                  </span>
                  <small>
                    <span className={`thread-source ${isClaudeProvider(session.provider) ? 'is-claude' : 'is-codex'}`}>
                      {isClaudeProvider(session.provider) ? 'Claude' : session.provider ? 'Codex' : agent.shortLabel}
                    </span>
                    {session.draft ? '待发送' : formatTime(session.updatedAt)}
                  </small>
                </button>
                <div className="thread-actions">
                  {onTogglePin && !session.draft ? (
                    <button
                      type="button"
                      className="thread-pin"
                      onClick={(event) => stopThreadAction(event, () => onTogglePin(project, session))}
                      aria-label={session.pinned ? '取消置顶' : '置顶'}
                      title={session.pinned ? '取消置顶' : '置顶'}
                    >
                      {session.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                    </button>
                  ) : null}
                  {!session.draft && isClaudeProvider(session.provider) ? (
                    <CopyResumeButton sessionId={session.id} />
                  ) : null}
                  <button
                    type="button"
                    className="thread-rename"
                    onClick={(event) => stopThreadAction(event, () => onRenameSession(project, session))}
                    aria-label="重命名线程"
                    title="重命名线程"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="thread-delete"
                    onClick={(event) => stopThreadAction(event, () => onDeleteSession(project, session))}
                    aria-label="删除线程"
                    title="删除线程"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="thread-empty">暂无线程</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

const SEARCH_DAYS_OPTIONS = [7, 30, 90];

function normalizeCwdPath(value) {
  return String(value || '').replace(/\\/g, '/').toLowerCase();
}

// Resolve a session's cwd to a known project (Win32 + mixed-slash paths
// compared case-insensitively after collapse). Mirrors the deep-link and
// Git-panel matching so search lands the chat in the right project scope.
function resolveProjectByCwd(cwd, projects) {
  const norm = normalizeCwdPath(cwd);
  if (!norm || !Array.isArray(projects)) return null;
  return projects.find((p) => normalizeCwdPath(p.path) === norm) || null;
}

// Friendly label for a search hit: the matched project's name, else the
// last path segment of the raw cwd so a worktree / unlisted project still
// reads as something (not a blank row).
function projectLabelForResult(cwd, matchedProject) {
  if (matchedProject) return matchedProject.name || matchedProject.path || '';
  const segments = String(cwd || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return segments[segments.length - 1] || '';
}

function SessionSearch({ peers, currentAgent, onClose, onSelectSession, onSelectProject, onNewConversation, agent, projects, selectedProject }) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Filter chips state. 'all' agent = no filter; days picks the lookback
  // window; projectScope only meaningful when selectedProject is set.
  const [agentFilter, setAgentFilter] = useState('all');
  const [daysFilter, setDaysFilter] = useState(90);
  const [projectScope, setProjectScope] = useState(false);
  const projectMatches = useMemo(() => {
    if (!debouncedQuery) return [];
    const source = projectScope && selectedProject?.id ? [selectedProject] : projects;
    return (Array.isArray(source) ? source : [])
      .filter((project) => projectMatchesQuery(project, debouncedQuery))
      .slice(0, 6);
  }, [debouncedQuery, projectScope, projects, selectedProject]);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(handle);
  }, [query]);

  // Reset projectScope when the selected project goes away (e.g. user
  // navigates to a project-less view); otherwise leave it alone.
  useEffect(() => {
    if (!selectedProject?.id) setProjectScope(false);
  }, [selectedProject?.id]);

  useEffect(() => {
    if (!debouncedQuery) {
      setResults([]);
      setError('');
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({
      q: debouncedQuery,
      limit: '20',
      days: String(daysFilter)
    });
    if (agentFilter !== 'all') params.set('agent', agentFilter);
    if (projectScope && selectedProject?.id) params.set('projectId', selectedProject.id);
    apiFetch(`/api/search?${params.toString()}`)
      .then((data) => {
        if (cancelled) return;
        setResults(Array.isArray(data?.results) ? data.results : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || '搜索失败');
        setResults([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [debouncedQuery, agentFilter, daysFilter, projectScope, selectedProject?.id]);

  function handleResultClick(result) {
    const isForeign = result.agent && currentAgent && result.agent !== currentAgent;
    if (isForeign) {
      const peer = Array.isArray(peers) ? peers.find((p) => p.agent === result.agent) : null;
      if (peer) {
        if (typeof window !== 'undefined') {
          window.location.href = `${peer.url.replace(/\/$/, '')}/?session=${encodeURIComponent(result.sessionId)}`;
        }
        return;
      }
      // No peer registered for this foreign agent — the local server
      // can't resume that session (wrong backend), so doing nothing
      // is more honest than loading an empty chat. The result row's
      // "需要切换服务器" hint already tells the user what to do.
      return;
    }
    const matched = resolveProjectByCwd(result.cwd, projects);
    // Pass the resolved project as the second arg so handleSelectSession can
    // switch the app's project context (header, Git scope) — otherwise a
    // cross-project jump from search leaves the top bar on the old project.
    onSelectSession?.({
      id: result.sessionId,
      projectId: matched?.id || null,
      title: ''
    }, matched || null);
  }

  return (
    <section className="drawer-section drawer-search">
      <div className="drawer-search-bar">
        <button className="icon-button drawer-toolbar-close" onClick={onClose} aria-label="关闭菜单">
          <X size={18} />
        </button>
        <div className="drawer-search-input">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            placeholder="搜索项目或对话…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索项目或对话"
          />
          {query ? (
            <button
              type="button"
              className="drawer-search-clear"
              onClick={() => setQuery('')}
              aria-label="清空"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className={`drawer-new-compact ${agent?.accentClass || ''}`}
          onClick={onNewConversation}
          aria-label="新对话"
          title={agent?.newConversationHint ? `新对话 · ${agent.newConversationHint}` : '新对话'}
        >
          <Plus size={15} />
          <span>新建</span>
        </button>
      </div>
      {debouncedQuery ? (
        <div className="drawer-search-filters" role="group" aria-label="搜索过滤">
          <div className="drawer-search-chip-group" aria-label="agent">
            {['all', 'codex', 'claude'].map((value) => (
              <button
                key={value}
                type="button"
                className={`drawer-search-chip ${agentFilter === value ? 'is-active' : ''}`}
                onClick={() => setAgentFilter(value)}
              >
                {value === 'all' ? '全部' : value === 'codex' ? 'Codex' : 'Claude'}
              </button>
            ))}
          </div>
          <div className="drawer-search-chip-group" aria-label="窗口">
            {SEARCH_DAYS_OPTIONS.map((value) => (
              <button
                key={value}
                type="button"
                className={`drawer-search-chip ${daysFilter === value ? 'is-active' : ''}`}
                onClick={() => setDaysFilter(value)}
              >
                {value}天
              </button>
            ))}
          </div>
          {selectedProject?.id ? (
            <button
              type="button"
              className={`drawer-search-chip ${projectScope ? 'is-active' : ''}`}
              onClick={() => setProjectScope((v) => !v)}
              title={selectedProject.name}
            >
              限定当前项目
            </button>
          ) : null}
        </div>
      ) : null}
      {loading ? (
        <div className="drawer-search-status">
          <Loader2 className="spin" size={12} /> 搜索中…
        </div>
      ) : null}
      {error ? <div className="drawer-search-error">{error}</div> : null}
      {projectMatches.length > 0 ? (
        <div className="drawer-search-project-matches">
          <div className="drawer-search-result-heading">项目</div>
          <ul className="drawer-search-results">
            {projectMatches.map((project) => (
              <li key={`project-${project.id}`}>
                <button
                  type="button"
                  className="drawer-search-main drawer-search-project-main"
                  onClick={() => onSelectProject?.(project)}
                  title={project.path || project.name}
                >
                  <div className="drawer-search-meta">
                    <Folder size={13} aria-hidden="true" />
                    <span className="drawer-search-project" title={project.path || ''}>{project.name}</span>
                    <small className="drawer-search-project-count">{project.sessionCount || 0} 对话</small>
                  </div>
                  <div className="drawer-search-snippet">{compactPath(project.path)}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!loading && debouncedQuery && results.length === 0 && projectMatches.length === 0 && !error ? (
        <div className="drawer-search-status">没有匹配</div>
      ) : null}
      {results.length > 0 ? (
        <ul className="drawer-search-results">
          {results.map((r, idx) => {
            const isForeign = r.agent && currentAgent && r.agent !== currentAgent;
            const peer = isForeign && Array.isArray(peers)
              ? peers.find((p) => p.agent === r.agent)
              : null;
            const unreachable = isForeign && !peer;
            const matchedProject = resolveProjectByCwd(r.cwd, projects);
            const projectLabel = projectLabelForResult(r.cwd, matchedProject);
            return (
              <li key={`${idx}-${r.sessionId}`} className={unreachable ? 'is-unreachable' : ''}>
                <div className="drawer-search-row">
                  <button
                    type="button"
                    className="drawer-search-main"
                    onClick={() => handleResultClick(r)}
                    title={r.cwd || ''}
                    disabled={unreachable}
                  >
                    <div className="drawer-search-meta">
                      {r.agent ? (
                        <span className={`thread-source is-${r.agent}`}>{r.agent === 'claude' ? 'Claude' : 'Codex'}</span>
                      ) : null}
                      {projectLabel ? (
                        <span className="drawer-search-project" title={r.cwd || ''}>{projectLabel}</span>
                      ) : null}
                      <span className="drawer-search-hash">{r.sessionId.slice(0, 8)}</span>
                      {isForeign ? (
                        <small className="drawer-search-peer">{peer ? `→ ${peer.label}` : '需要切换服务器'}</small>
                      ) : null}
                    </div>
                    <div className="drawer-search-snippet">{r.snippet}</div>
                  </button>
                  <CopyResumeButton sessionId={r.sessionId} title="复制完整 session id" />
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

export function Drawer({
  open,
  onClose,
  projects,
  pinFolders,
  pinnedSessions,
  selectedProject,
  selectedSession,
  expandedProjectIds,
  sessionsByProject,
  loadingProjectId,
  onToggleProject,
  onSelectProject,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onArchiveProject,
  onRestoreProject,
  onTogglePin,
  onMoveSessionToFolder,
  onCreatePinFolder,
  onRenamePinFolder,
  onDeletePinFolder,
  onToggleFolderCollapsed,
  onNewConversation,
  onSync,
  onOpenGit,
  onOpenNotifications,
  onOpenActivity,
  onShowConnectionStatus,
  peers = [],
  syncing,
  theme,
  setTheme,
  status,
  desktopBridge,
  runtimePrefs,
  onSetRuntimePref
}) {
  const openDesktopThreadSet = useMemo(() => new Set(desktopBridge?.openThreadIds || []), [desktopBridge?.openThreadIds]);
  const [drawerView, setDrawerView] = useState('main');
  const [pinnedExpanded, setPinnedExpanded] = useState(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem('codexmobile.pinnedSectionExpanded') === '1';
  });
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem('codexmobile.pinnedSectionExpanded', pinnedExpanded ? '1' : '0');
  }, [pinnedExpanded]);
  const [toolGroupExpanded, setToolGroupExpanded] = useState(() => {
    if (typeof localStorage === 'undefined') return { ops: false, settings: false };
    try {
      const raw = localStorage.getItem('codexmobile.toolGroupExpanded');
      const parsed = raw ? JSON.parse(raw) : null;
      return {
        ops: Boolean(parsed?.ops),
        settings: Boolean(parsed?.settings)
      };
    } catch {
      return { ops: false, settings: false };
    }
  });
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem('codexmobile.toolGroupExpanded', JSON.stringify(toolGroupExpanded));
  }, [toolGroupExpanded]);
  function toggleToolGroup(key) {
    setToolGroupExpanded((current) => ({ ...current, [key]: !current[key] }));
  }
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaLoaded, setQuotaLoaded] = useState(false);
  const [quotaError, setQuotaError] = useState('');
  const [quotaAccount, setQuotaAccount] = useState(null);
  const [showOlderProjects, setShowOlderProjects] = useState(false);
  const [showOtherProjects, setShowOtherProjects] = useState(false);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [archivedProjects, setArchivedProjects] = useState([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [projectsExpanded, setProjectsExpanded] = useState(() => {
    if (typeof localStorage === 'undefined') return true;
    return localStorage.getItem('codexmobile.projectsSectionExpanded') !== '0';
  });
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem('codexmobile.projectsSectionExpanded', projectsExpanded ? '1' : '0');
  }, [projectsExpanded]);
  const agent = agentMeta(status);
  async function loadArchivedProjects() {
    setArchivedLoading(true);
    try {
      const data = await apiFetch('/api/projects/archived');
      setArchivedProjects(Array.isArray(data?.projects) ? data.projects : []);
    } catch {
      setArchivedProjects([]);
    } finally {
      setArchivedLoading(false);
    }
  }
  useEffect(() => {
    if (!open || !archivedExpanded) return;
    loadArchivedProjects();
  }, [open, archivedExpanded]);

  async function handleRestoreArchived(project) {
    const restored = await onRestoreProject?.(project);
    if (restored) {
      await loadArchivedProjects();
    }
  }

  const { primaryProjects, olderProjects, otherProjects } = useMemo(() => (
    classifyDrawerProjects({
      projects,
      sessionsByProject,
      selectedProjectId: selectedProject?.id || ''
    })
  ), [projects, sessionsByProject, selectedProject?.id, open]);

  async function refreshCodexQuota(event) {
    event?.preventDefault();
    event?.stopPropagation();
    if (quotaLoading) {
      return;
    }
    setQuotaLoading(true);
    setQuotaError('');
    try {
      const result = await apiFetch('/api/quotas/codex');
      setQuotaAccount(result.account || (Array.isArray(result.accounts) ? result.accounts[0] : null) || null);
      setQuotaLoaded(true);
    } catch {
      setQuotaAccount(null);
      setQuotaError('查询失败，点击刷新重试');
      setQuotaLoaded(true);
    } finally {
      setQuotaLoading(false);
    }
  }

  if (drawerView === 'settings') {
    return (
      <>
        <div className={`drawer-backdrop ${open ? 'is-open' : ''}`} onClick={onClose} />
        <aside className={`drawer ${open ? 'is-open' : ''}`}>
          <div className="drawer-subheader">
            <button className="icon-button" onClick={() => setDrawerView('main')} aria-label="返回">
              <ChevronLeft size={22} />
            </button>
            <strong>设置</strong>
            <button className="icon-button" onClick={onClose} aria-label="关闭菜单">
              <X size={20} />
            </button>
          </div>
          <div className="settings-view">
            <section className="settings-group">
              <div className="drawer-heading">外观</div>
              <div className="theme-setting">
                <div className="theme-setting-title">
                  <span>主题选择</span>
                </div>
                <div className="theme-segment" role="group" aria-label="主题选择">
                  <button
                    type="button"
                    className={theme === 'light' ? 'is-selected' : ''}
                    onClick={() => setTheme('light')}
                  >
                    白色
                  </button>
                  <button
                    type="button"
                    className={theme === 'dark' ? 'is-selected' : ''}
                    onClick={() => setTheme('dark')}
                  >
                    黑色
                  </button>
                </div>
              </div>
            </section>
            <section className="settings-group">
              <div className="drawer-heading">高级</div>
              <div className="theme-setting">
                <div className="theme-setting-title">
                  <span>桌面 IPC 直发</span>
                  <small>
                    打开后，发消息会优先尝试 IPC 接管 desktop 已打开的会话。关闭则永远走 CLI。
                  </small>
                </div>
                <div className="theme-segment" role="group" aria-label="桌面 IPC 直发">
                  <button
                    type="button"
                    className={runtimePrefs?.ipcTurnsEnabled ? 'is-selected' : ''}
                    onClick={() => onSetRuntimePref?.('ipcTurnsEnabled', true)}
                  >
                    开启
                  </button>
                  <button
                    type="button"
                    className={!runtimePrefs?.ipcTurnsEnabled ? 'is-selected' : ''}
                    onClick={() => onSetRuntimePref?.('ipcTurnsEnabled', false)}
                  >
                    关闭
                  </button>
                </div>
              </div>
              {onShowConnectionStatus ? (
                <button type="button" className="settings-entry" onClick={onShowConnectionStatus}>
                  <span>
                    <Wifi size={18} />
                    连接详情
                  </span>
                  <ChevronRight size={17} />
                </button>
              ) : null}
              <button type="button" className="settings-entry" onClick={onOpenNotifications}>
                <span>
                  <Bell size={18} />
                  通知（实验性）
                </span>
                <ChevronRight size={17} />
              </button>
              {onOpenActivity ? (
                <button type="button" className="settings-entry" onClick={onOpenActivity}>
                  <span>
                    <RefreshCw size={18} />
                    近况
                  </span>
                  <ChevronRight size={17} />
                </button>
              ) : null}
              <div className="settings-note">
                Web Push 走 FCM，国内网络通常不可达。如需启用：让 PC 作为 Tailscale exit node 并开科学上网。
              </div>
            </section>
          </div>
        </aside>
      </>
    );
  }

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'is-open' : ''}`} onClick={onClose} />
      <aside className={`drawer ${open ? 'is-open' : ''}`}>
        <SessionSearch
          peers={peers}
          currentAgent={agent.id}
          onClose={onClose}
          onSelectSession={onSelectSession}
          onSelectProject={onSelectProject}
          onNewConversation={onNewConversation}
          agent={agent}
          projects={projects}
          selectedProject={selectedProject}
        />

        <PinnedSection
          projects={projects}
          sessionsByProject={sessionsByProject}
          pinnedSessions={pinnedSessions}
          pinFolders={pinFolders}
          selectedSession={selectedSession}
          agent={agent}
          expanded={pinnedExpanded}
          onToggleExpanded={() => setPinnedExpanded((current) => !current)}
          onSelectSession={onSelectSession}
          onTogglePin={onTogglePin}
          onMoveSession={onMoveSessionToFolder}
          onCreateFolder={onCreatePinFolder}
          onRenameFolder={onRenamePinFolder}
          onDeleteFolder={onDeletePinFolder}
          onToggleFolderCollapsed={onToggleFolderCollapsed}
        />

        <section className={`drawer-section project-section ${projectsExpanded ? 'is-expanded' : 'is-collapsed'}`}>
          <button
            type="button"
            className="drawer-heading drawer-heading-toggle"
            onClick={() => setProjectsExpanded((prev) => !prev)}
            aria-expanded={projectsExpanded}
          >
            <span>项目</span>
            <small className="drawer-heading-count">{projects.length}</small>
            <ChevronDown size={14} className="drawer-heading-chevron" />
          </button>
          {projectsExpanded ? (
          <div className="project-list">
            {primaryProjects.map((project) => renderProjectGroup({
              project,
              selectedProject,
              expandedProjectIds,
              sessionsByProject,
              loadingProjectId,
              selectedSession,
              agent,
              onToggleProject,
              onSelectSession,
              onRenameSession,
              onDeleteSession,
              onArchiveProject,
              onTogglePin,
              openThreadIds: openDesktopThreadSet
            }))}
            {olderProjects.length ? (
              <>
                <button
                  type="button"
                  className={`project-row older-toggle ${showOlderProjects ? 'is-expanded' : ''}`}
                  onClick={() => setShowOlderProjects((prev) => !prev)}
                >
                  <Folder size={18} />
                  <span>
                    <strong>7 天前</strong>
                    <small>较早的项目</small>
                  </span>
                  <small className="project-count">{olderProjects.length}</small>
                  <ChevronDown size={15} className="project-chevron" />
                </button>
                {showOlderProjects ? olderProjects.map((project) => renderProjectGroup({
                  project,
                  selectedProject,
                  expandedProjectIds,
                  sessionsByProject,
                  loadingProjectId,
                  selectedSession,
                  agent,
                  onToggleProject,
                  onSelectSession,
                  onRenameSession,
                  onDeleteSession,
                  onArchiveProject,
                  onTogglePin,
                  openThreadIds: openDesktopThreadSet
                })) : null}
              </>
            ) : null}
            {otherProjects.length ? (
              <>
                <button
                  type="button"
                  className={`project-row older-toggle other-projects-toggle ${showOtherProjects ? 'is-expanded' : ''}`}
                  onClick={() => setShowOtherProjects((prev) => !prev)}
                  aria-expanded={showOtherProjects}
                >
                  <Folder size={18} />
                  <span>
                    <strong>其他项目</strong>
                    <small>无对话 / 父目录 / 临时目录</small>
                  </span>
                  <small className="project-count">{otherProjects.length}</small>
                  <ChevronDown size={15} className="project-chevron" />
                </button>
                {showOtherProjects ? otherProjects.map((project) => renderProjectGroup({
                  project,
                  selectedProject,
                  expandedProjectIds,
                  sessionsByProject,
                  loadingProjectId,
                  selectedSession,
                  agent,
                  onToggleProject,
                  onSelectSession,
                  onRenameSession,
                  onDeleteSession,
                  onArchiveProject,
                  onTogglePin,
                  openThreadIds: openDesktopThreadSet
                })) : null}
              </>
            ) : null}
          </div>
          ) : null}
        </section>

        <section className={`drawer-section archived-project-section ${archivedExpanded ? 'is-expanded' : 'is-collapsed'} ${archivedProjects.length <= 6 ? 'is-short' : ''}`}>
          <button
            type="button"
            className="drawer-heading drawer-heading-toggle"
            onClick={() => setArchivedExpanded((prev) => !prev)}
            aria-expanded={archivedExpanded}
          >
            <span>已归档</span>
            <small className="drawer-heading-count">{archivedProjects.length}</small>
            <ChevronDown size={14} className="drawer-heading-chevron" />
          </button>
          {archivedExpanded ? (
            <div className="archived-project-list">
              {archivedLoading ? (
                <div className="thread-empty">
                  <Loader2 className="spin" size={14} />
                  加载中
                </div>
              ) : archivedProjects.length ? (
                archivedProjects.map((project) => (
                  <div key={project.id} className="archived-project-row">
                    <Folder size={18} />
                    <span>
                      <strong title={project.name}>{project.name || project.id}</strong>
                      <small title={project.path}>{compactPath(project.path)}</small>
                    </span>
                    <button
                      type="button"
                      className="project-restore"
                      onClick={() => handleRestoreArchived(project)}
                      aria-label="恢复项目"
                      title="恢复项目"
                    >
                      <RotateCcw size={15} />
                    </button>
                  </div>
                ))
              ) : (
                <div className="thread-empty">暂无归档项目</div>
              )}
            </div>
          ) : null}
        </section>

        <section className="drawer-section drawer-controls">
          <div className="drawer-sublabel">工具与服务</div>

          {/* Codex-only local controls. Keep both actions direct: one sync
              button and one quota refresh button for the single ChatGPT account. */}
          {agent.id === 'codex' ? (
            <>
              <button type="button" className="tool-group-action drawer-sync-action" onClick={onSync} disabled={syncing}>
                {syncing ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                <span>{syncing ? '同步中' : '同步对话'}</span>
                <small>{syncing ? '正在刷新会话列表' : '刷新本机会话列表'}</small>
              </button>

              <div className="quota-single">
                <button type="button" className="tool-group-action quota-single-refresh" onClick={refreshCodexQuota} disabled={quotaLoading}>
                  {quotaLoading ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                  <span>{quotaLoading ? '刷新额度中' : '刷新额度'}</span>
                  <small>{quotaAccount ? `${quotaAccount.plan || 'Codex'} · ${quotaAccount.label || '当前 ChatGPT 账号'}` : '当前 ChatGPT 账号'}</small>
                </button>

                {quotaError ? (
                  <button type="button" className="quota-error" onClick={refreshCodexQuota}>
                    {quotaError}
                  </button>
                ) : null}

                {!quotaError && quotaAccount ? (() => {
                  const windows = Array.isArray(quotaAccount.windows) ? quotaAccount.windows : [];
                  const accountStatus = quotaAccount.status || 'ok';
                  return (
                    <div className={`quota-account quota-account-single is-${accountStatus}`}>
                      {windows.length ? (
                        <div className="quota-window-list">
                          {windows.map((quotaWindow) => {
                            const percent = quotaRemainingPercent(quotaWindow);
                            const resetText = formatQuotaReset(quotaWindow);
                            return (
                              <div
                                key={quotaWindow.id}
                                className={`quota-window ${quotaToneClass(percent)}`}
                                style={{ '--quota-percent': `${percent ?? 0}%` }}
                              >
                                <div className="quota-window-meta">
                                  <span>{quotaWindow.label}</span>
                                  <strong>{formatQuotaPercent(quotaWindow)}</strong>
                                </div>
                                <div className="quota-bar">
                                  <span />
                                </div>
                                {resetText ? <div className="quota-window-reset">{resetText}</div> : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="quota-account-message"
                          onClick={accountStatus === 'failed' ? refreshCodexQuota : undefined}
                        >
                          {quotaAccount.error || '查询失败，点击刷新重试'}
                        </button>
                      )}
                    </div>
                  );
                })() : null}

                {!quotaLoading && !quotaError && quotaLoaded && !quotaAccount ? (
                  <div className="quota-empty">暂无 ChatGPT 凭证</div>
                ) : null}
              </div>
            </>
          ) : null}

          <div className={`tool-group ${toolGroupExpanded.ops ? 'is-expanded' : ''}`}>
            <button type="button" className="tool-group-header" onClick={() => toggleToolGroup('ops')} aria-expanded={toolGroupExpanded.ops}>
              <GitBranch size={16} />
              <span>Git</span>
              <ChevronDown size={16} className="tool-group-chevron" />
            </button>
            {toolGroupExpanded.ops ? (
              <div className="tool-group-body">
                <button
                  type="button"
                  className="tool-group-action"
                  onClick={onOpenGit}
                  disabled={!selectedProject}
                  title={selectedProject ? `Git · ${selectedProject.name}` : 'Git（请先选择项目）'}
                >
                  <GitBranch size={16} />
                  <span>Git 操作</span>
                  {selectedProject ? <small>{selectedProject.name}</small> : <small>请先选择项目</small>}
                  <ChevronRight size={15} />
                </button>
              </div>
            ) : null}
          </div>

          <div className={`tool-group ${toolGroupExpanded.settings ? 'is-expanded' : ''}`}>
            <button type="button" className="tool-group-header" onClick={() => toggleToolGroup('settings')} aria-expanded={toolGroupExpanded.settings}>
              <Settings size={16} />
              <span>设置与帮助</span>
              <ChevronDown size={16} className="tool-group-chevron" />
            </button>
            {toolGroupExpanded.settings ? (
              <div className="tool-group-body">
                <button type="button" className="tool-group-action" onClick={() => setDrawerView('settings')}>
                  <Settings size={16} />
                  <span>偏好设置</span>
                  <ChevronRight size={15} />
                </button>
                <div className="tool-group-hint">
                  <small>桌面端在线后，发消息默认走 IPC（已在 .env 开启）。Pin / Git / 通知设置均独立保存。</small>
                </div>
              </div>
            ) : null}
          </div>
        </section>
      </aside>
    </>
  );
}
