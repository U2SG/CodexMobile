// "#" quick prompts — a user-curated palette of common follow-ups they
// reach for often, surfaced from the composer via the same token-picker
// pattern as "/" slash commands and "@" file refs.
//
// Storage shape (in localStorage at `codexmobile.quickPrompts`):
//   { pinned: [{ id, label, prompt, pinnedAt }], recent: [{ prompt, usedAt }] }
//
// recent: auto-populated when the user selects something from the picker
// (or uses a pinned prompt). Capped at RECENT_LIMIT, ordered most-recent
// first, de-duped by prompt text.
//
// pinned: explicit user action via the pin button on each picker row.
// First-ever load seeds with a few useful defaults so the picker isn't
// empty on day one.

const STORAGE_KEY = 'codexmobile.quickPrompts';
const RECENT_LIMIT = 20;

// Seed presets — the user can unpin any of these. They're stored as
// regular pinned entries on first save so editing / removing them is
// the same as any user-pinned prompt.
export const SEED_PROMPTS = [
  { id: 'seed-summarize', label: '总结对话', prompt: '请把当前对话的关键决策、结论和未完成项总结成要点。' },
  { id: 'seed-review', label: '代码审查', prompt: '请以代码审查视角检查最近改动，列出 bug / 行为回归 / 风险 / 缺失测试，给出具体文件位置。' },
  { id: 'seed-refactor', label: '重构建议', prompt: '请分析这段代码的可读性和可维护性，给出 3 条具体的重构建议（不要立刻动手）。' },
  { id: 'seed-test', label: '补单测', prompt: '请为这段代码补一组单元测试，覆盖正常路径 + 至少两条边界情形。' }
];

function safeParse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isValidPrompt(entry) {
  return entry && typeof entry === 'object' && typeof entry.prompt === 'string' && entry.prompt.trim();
}

function isValidPinned(entry) {
  return isValidPrompt(entry) && typeof entry.id === 'string' && entry.id;
}

export function getStoredPrompts(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (!storage) return seedDefault();
  const raw = storage.getItem(STORAGE_KEY);
  const parsed = safeParse(raw);
  if (!parsed || typeof parsed !== 'object') {
    return seedDefault();
  }
  const pinned = Array.isArray(parsed.pinned) ? parsed.pinned.filter(isValidPinned) : [];
  const recent = Array.isArray(parsed.recent) ? parsed.recent.filter(isValidPrompt) : [];
  if (pinned.length === 0 && recent.length === 0 && !parsed.bootstrapped) {
    return seedDefault();
  }
  return { pinned, recent };
}

function seedDefault() {
  const now = Date.now();
  return {
    pinned: SEED_PROMPTS.map((seed) => ({ ...seed, pinnedAt: now })),
    recent: []
  };
}

function saveStoredPrompts(state, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      pinned: state.pinned || [],
      recent: state.recent || [],
      bootstrapped: true
    }));
  } catch {
    // localStorage quota / disabled — silently no-op; recent list will
    // just reset on reload, no functional impact.
  }
}

export function recordPromptUse(prompt, storage) {
  const text = String(prompt || '').trim();
  if (!text) return getStoredPrompts(storage);
  const current = getStoredPrompts(storage);
  // Remove any existing recent entry for the same text so it floats to
  // the top instead of duplicating.
  const filtered = current.recent.filter((entry) => entry.prompt !== text);
  const next = {
    pinned: current.pinned,
    recent: [{ prompt: text, usedAt: Date.now() }, ...filtered].slice(0, RECENT_LIMIT)
  };
  saveStoredPrompts(next, storage);
  return next;
}

export function pinPrompt({ id, label, prompt }, storage) {
  const text = String(prompt || '').trim();
  if (!text) return getStoredPrompts(storage);
  const current = getStoredPrompts(storage);
  // De-dupe pinned by id; replace if exists.
  const filteredPinned = current.pinned.filter((entry) => entry.id !== id);
  const next = {
    pinned: [{ id, label: String(label || '').trim() || text.slice(0, 24), prompt: text, pinnedAt: Date.now() }, ...filteredPinned],
    // Drop the same text from recent — it's now first-class pinned.
    recent: current.recent.filter((entry) => entry.prompt !== text)
  };
  saveStoredPrompts(next, storage);
  return next;
}

export function unpinPrompt(id, storage) {
  const current = getStoredPrompts(storage);
  const next = {
    pinned: current.pinned.filter((entry) => entry.id !== id),
    recent: current.recent
  };
  saveStoredPrompts(next, storage);
  return next;
}

export function filteredQuickPrompts(query, { pinned = [], recent = [] } = {}) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) {
    return { pinned, recent };
  }
  const matches = (entry) => {
    const haystack = `${entry.label || ''}\n${entry.prompt || ''}`.toLowerCase();
    return haystack.includes(normalized);
  };
  return {
    pinned: pinned.filter(matches),
    recent: recent.filter(matches)
  };
}
