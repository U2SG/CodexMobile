// Pinned-sessions section rendered inside the project drawer. Groups
// pinned sessions into folders (with collapsible folder headers) plus a
// loose "ungrouped" bucket; supports per-row move-to-folder / unpin and
// per-folder rename / delete / collapse.
//
// Extracted from App.jsx (Batch G R21). Pure presentation — all data and
// handlers flow in as props; no App-scope state.
//
// `stopThreadAction` is duplicated here as a module-local helper because
// the inline Drawer in App.jsx still uses its own copy. When Drawer is
// extracted (R23) the helper will be centralised into a shared file.

import {
  ChevronDown,
  Folder,
  FolderPlus,
  Pencil,
  Pin,
  PinOff,
  Trash2
} from 'lucide-react';
import { isClaudeProvider } from '../agent-meta.js';
import { CopyResumeButton } from '../chat/CopyResumeButton.jsx';
import { formatTime } from '../format-time.js';

function stopThreadAction(event, action) {
  event.preventDefault();
  event.stopPropagation();
  action();
}

export function PinnedSection({
  projects,
  sessionsByProject,
  pinnedSessions,
  pinFolders,
  selectedSession,
  agent,
  expanded,
  onToggleExpanded,
  onSelectSession,
  onTogglePin,
  onMoveSession,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onToggleFolderCollapsed
}) {
  const projectById = new Map((projects || []).map((project) => [project.id, project]));
  const seenIds = new Set();
  const allPinned = [];
  for (const session of pinnedSessions || []) {
    if (!session?.id || seenIds.has(session.id)) continue;
    seenIds.add(session.id);
    const project =
      (session.projectId && projectById.get(session.projectId)) ||
      {
        id: session.projectId || null,
        name: session.projectName || '未知项目',
        path: session.projectPath || ''
      };
    allPinned.push({ project, session });
  }
  // Fallback: also include any locally-loaded sessions flagged pinned that weren't returned by the API
  // (e.g. optimistic pin before server snapshot syncs).
  for (const [projectId, sessions] of Object.entries(sessionsByProject || {})) {
    const project = projectById.get(projectId);
    if (!project) continue;
    for (const session of sessions) {
      if (session.pinned && !seenIds.has(session.id)) {
        seenIds.add(session.id);
        allPinned.push({ project, session });
      }
    }
  }
  if (!allPinned.length && !pinFolders.length) {
    return null;
  }
  allPinned.sort((a, b) => new Date(b.session.pinnedAt || 0) - new Date(a.session.pinnedAt || 0));
  const groups = new Map();
  groups.set(null, []);
  for (const folder of pinFolders) groups.set(folder.id, []);
  for (const item of allPinned) {
    const folderId = item.session.folderId && groups.has(item.session.folderId) ? item.session.folderId : null;
    groups.get(folderId).push(item);
  }
  const ungrouped = groups.get(null) || [];

  const renderItem = ({ project, session }) => (
    <div
      key={session.id}
      className={`thread-row is-pinned ${selectedSession?.id === session.id ? 'is-selected' : ''}`}
    >
      <button type="button" className="thread-main" onClick={() => onSelectSession(session)}>
        <span>
          <Pin size={12} className="thread-pin-indicator" />
          {session.title || '对话'}
        </span>
        <small>
          <span className={`thread-source ${isClaudeProvider(session.provider) ? 'is-claude' : 'is-codex'}`}>
            {isClaudeProvider(session.provider) ? 'Claude' : session.provider ? 'Codex' : agent.shortLabel}
          </span>
          {project.name} · {formatTime(session.updatedAt)}
        </small>
      </button>
      <div className="thread-actions">
        {isClaudeProvider(session.provider) ? (
          <CopyResumeButton sessionId={session.id} />
        ) : null}
        <button
          type="button"
          className="thread-rename"
          onClick={(event) => stopThreadAction(event, () => onMoveSession(session))}
          aria-label="移动到置顶分组"
          title="移动到置顶分组"
        >
          <Folder size={14} />
        </button>
        <button
          type="button"
          className="thread-pin"
          onClick={(event) => stopThreadAction(event, () => onTogglePin(project, session))}
          aria-label="取消置顶"
          title="取消置顶"
        >
          <PinOff size={14} />
        </button>
      </div>
    </div>
  );

  const totalPinned = allPinned.length;
  return (
    <section className={`drawer-section pinned-section ${expanded ? 'is-expanded' : 'is-collapsed'}`}>
      <div className="drawer-heading pinned-heading">
        <button
          type="button"
          className="pinned-section-toggle"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
        >
          <ChevronDown size={13} className="pinned-section-chevron" />
          <span>置顶</span>
          {totalPinned ? <small className="pinned-count">{totalPinned}</small> : null}
        </button>
        {expanded ? (
          <button
            type="button"
            className="pinned-add-folder"
            onClick={onCreateFolder}
            aria-label="新建置顶分组"
            title="新建置顶分组"
          >
            <FolderPlus size={14} />
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div className="pinned-list">
          {pinFolders.map((folder) => {
            const items = groups.get(folder.id) || [];
            return (
              <div key={folder.id} className={`pinned-folder ${folder.collapsed ? 'is-collapsed' : ''}`}>
                <div className="pinned-folder-header">
                  <button
                    type="button"
                    className="pinned-folder-toggle"
                    onClick={() => onToggleFolderCollapsed(folder)}
                  >
                    <ChevronDown size={14} className="pinned-folder-chevron" />
                    <Folder size={14} />
                    <strong>{folder.name}</strong>
                    <small>{items.length}</small>
                  </button>
                  <button
                    type="button"
                    className="thread-rename"
                    onClick={() => onRenameFolder(folder)}
                    aria-label="重命名置顶分组"
                    title="重命名置顶分组"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="thread-delete"
                    onClick={() => onDeleteFolder(folder)}
                    aria-label="删除置顶分组"
                    title="删除置顶分组"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {!folder.collapsed ? (
                  <div className="thread-list">
                    {items.length ? items.map(renderItem) : <div className="thread-empty">空</div>}
                  </div>
                ) : null}
              </div>
            );
          })}
          {ungrouped.length ? (
            <div className="pinned-folder pinned-folder-loose">
              <div className="thread-list">{ungrouped.map(renderItem)}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
