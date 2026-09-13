export const PWA_THEME_META = {
  light: {
    themeColor: '#ffffff',
    statusBarStyle: 'default'
  },
  dark: {
    themeColor: '#000000',
    statusBarStyle: 'black-translucent'
  }
};

export function normalizePwaTheme(theme) {
  return theme === 'dark' || theme === 'system' ? theme : 'light';
}

export function resolvePwaTheme(theme, win = globalThis.window) {
  const preference = normalizePwaTheme(theme);
  if (preference !== 'system') {
    return preference;
  }
  return win?.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
}

export function applyPwaTheme(theme, doc = globalThis.document) {
  const preference = normalizePwaTheme(theme);
  const resolvedTheme = resolvePwaTheme(preference, doc?.defaultView || globalThis.window);
  const meta = {
    ...PWA_THEME_META[resolvedTheme],
    preference,
    resolvedTheme
  };

  if (!doc) {
    return meta;
  }

  if (doc.documentElement?.dataset) {
    doc.documentElement.dataset.theme = resolvedTheme;
    doc.documentElement.dataset.themePreference = preference;
  }

  doc.querySelector?.('meta[data-app-theme-color]')?.setAttribute?.('content', meta.themeColor);
  doc.querySelector?.('meta[data-app-status-bar-style]')?.setAttribute?.('content', meta.statusBarStyle);

  return meta;
}
