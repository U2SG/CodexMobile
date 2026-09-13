import { MarkdownContent } from '../chat/MarkdownContent.jsx';

function stripFrontmatter(value) {
  const text = String(value || '');
  if (!text.startsWith('---')) {
    return text;
  }
  return text.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trimStart();
}

function matches(pathLower, contentTypeLower) {
  if (contentTypeLower.includes('markdown')) return true;
  return /\.(?:md|markdown)(?:$|[:?#])/i.test(pathLower);
}

async function loader(blob) {
  const text = await blob.text();
  return { text };
}

// `mode` (rendered | raw | edit) is supplied by the FilePreview shell.
// In inline / chat-message mounts the prop isn't set, which falls
// through to the rendered branch — exactly what we want there.
function Component({ text, mode = 'rendered' }) {
  const body = String(text || '');
  if (mode === 'raw') {
    return <pre className="file-preview-text">{body}</pre>;
  }
  const cleaned = stripFrontmatter(body);
  return <MarkdownContent text={cleaned} className="file-preview-markdown message-content" />;
}

export const MarkdownViewer = {
  id: 'markdown',
  matches,
  loader,
  Component,
  toolbar: 'rendered-raw',
  capabilities: { canEdit: true, canAdjustFont: true, acceptsInline: true }
};
