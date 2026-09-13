// Plain-text viewer: source / config / log files. Renders as a <pre> with
// the file-preview-text class so the shell's font-scale variable applies.

const TEXT_EXTENSIONS = /\.(?:txt|csv|json|log|xml|html?|js|jsx|ts|tsx|mjs|cjs|css|yaml|yml|toml|ini|sh|ps1|py|go|rs|java|c|cpp|h|hpp)(?:$|[:?#])/i;

function matches(pathLower, contentTypeLower) {
  if (contentTypeLower.startsWith('text/')) return true;
  if (contentTypeLower.includes('json') || contentTypeLower.includes('xml')) return true;
  return TEXT_EXTENSIONS.test(pathLower);
}

async function loader(blob) {
  const text = await blob.text();
  return { text };
}

function Component({ text }) {
  return <pre className="file-preview-text">{String(text || '')}</pre>;
}

export const TextViewer = {
  id: 'text',
  matches,
  loader,
  Component,
  toolbar: 'plain',
  capabilities: { canEdit: true, canAdjustFont: true, acceptsInline: true }
};
