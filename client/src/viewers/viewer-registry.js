// Static viewer registry. Each viewer is a descriptor of the shape:
//
//   {
//     id: string,                               // 'markdown' | 'image' | ...
//     matches(pathLower, contentTypeLower),     // bool — used by file-preview path-based routing
//     loader(blob, headers) => viewerProps,     // turns a fetched Blob into the
//                                               //   props the Component expects;
//                                               //   may read text / arrayBuffer /
//                                               //   create an object URL etc.
//     Component(viewerProps + shell context),   // renders the body. Receives the
//                                               //   loader's output spread plus
//                                               //   shell-provided controls (mode,
//                                               //   draft, fontScale, …).
//     toolbar: 'rendered-raw' | 'plain' | 'pdf' | 'image' | 'download',
//                                               // tells the FilePreview shell
//                                               //   which control row to show
//     capabilities: { canEdit?: bool, canAdjustFont?: bool }
//                                               // shell capability gates
//   }
//
// Two consumer paths:
//   1. FilePreviewApp resolves by (path, contentType) → mounts inside a chrome
//      shell with toolbar + share/copy/save.
//   2. ChatMessage resolves by `id` (e.g. ```viewer:markdown``` fenced block)
//      → mounts inline, no shell chrome.
//
// Registration is explicit. Each viewer file exports its descriptor; the
// barrel module `client/src/viewers/index.js` imports them and calls
// `registerViewer()` in a fixed order. Resolution walks the list in
// registration order and picks the first match — order matters when a path
// could match more than one viewer (markdown beats text on `.md`).

const viewers = [];

export function registerViewer(viewer) {
  if (!viewer || typeof viewer !== 'object') {
    throw new Error('registerViewer: viewer must be an object');
  }
  if (!viewer.id || typeof viewer.id !== 'string') {
    throw new Error('registerViewer: viewer.id (string) is required');
  }
  if (typeof viewer.matches !== 'function') {
    throw new Error(`registerViewer(${viewer.id}): matches() is required`);
  }
  if (typeof viewer.Component !== 'function') {
    throw new Error(`registerViewer(${viewer.id}): Component is required`);
  }
  if (viewers.some((existing) => existing.id === viewer.id)) {
    throw new Error(`registerViewer: viewer id "${viewer.id}" is already registered`);
  }
  viewers.push(viewer);
}

export function resolveViewer({ path = '', contentType = '' } = {}) {
  const lowerPath = String(path || '').toLowerCase();
  const lowerType = String(contentType || '').toLowerCase();
  for (const viewer of viewers) {
    if (viewer.matches(lowerPath, lowerType)) return viewer;
  }
  return null;
}

export function resolveViewerById(id) {
  const target = String(id || '').toLowerCase();
  return viewers.find((viewer) => String(viewer.id).toLowerCase() === target) || null;
}

export function listViewers() {
  return [...viewers];
}

// Exposed for tests so they can start from a known-empty registry.
export function _resetForTest() {
  viewers.length = 0;
}
