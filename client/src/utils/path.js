// Path display helpers shared by app shell components. Extracted from
// App.jsx so that components moved into client/src/panels/ can import
// the helper without pulling in App-scope state.

// Shorten a project path for the chrome header / drawer chip. Keeps the
// last two path components (parent + leaf) when the path is deep enough,
// otherwise returns the normalized path. Handles Windows backslashes.
export function compactPath(value) {
  if (!value) {
    return '';
  }
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 2 ? `${parts.at(-2)}/${parts.at(-1)}` : normalized;
}
