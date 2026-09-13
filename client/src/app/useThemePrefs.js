import { useEffect, useState } from 'react';
import { THEME_KEY } from './session-utils.js';

export const DEFAULT_REASONING_EFFORT = 'xhigh';
export const REASONING_DEFAULT_VERSION = 'xhigh-v1';

const REASONING_KEY = 'codexmobile.reasoningEffort';
const REASONING_VERSION_KEY = 'codexmobile.reasoningDefaultVersion';

// Reads the saved reasoning effort, performing a one-shot migration when the
// stored default version is missing or stale. Exported so the version-bump
// behaviour can be tested without rendering the hook.
export function resolveInitialReasoningEffort(storage) {
  const defaultVersion = storage.getItem(REASONING_VERSION_KEY);
  if (defaultVersion !== REASONING_DEFAULT_VERSION) {
    storage.setItem(REASONING_VERSION_KEY, REASONING_DEFAULT_VERSION);
    storage.setItem(REASONING_KEY, DEFAULT_REASONING_EFFORT);
    return DEFAULT_REASONING_EFFORT;
  }
  return storage.getItem(REASONING_KEY) || DEFAULT_REASONING_EFFORT;
}

export function useThemePrefs({ statusReasoningEffort } = {}) {
  const [theme, setTheme] = useState(() =>
    localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  );
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState(
    () => resolveInitialReasoningEffort(localStorage)
  );

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (selectedReasoningEffort) {
      localStorage.setItem(REASONING_KEY, selectedReasoningEffort);
    }
  }, [selectedReasoningEffort]);

  useEffect(() => {
    const saved = localStorage.getItem(REASONING_KEY);
    if (!saved && statusReasoningEffort && !selectedReasoningEffort) {
      setSelectedReasoningEffort(statusReasoningEffort);
    }
  }, [selectedReasoningEffort, statusReasoningEffort]);

  return { theme, setTheme, selectedReasoningEffort, setSelectedReasoningEffort };
}
