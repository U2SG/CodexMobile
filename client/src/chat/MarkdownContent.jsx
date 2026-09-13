// Plain markdown renderer (no GeneratedImage routing, no inline-text user
// fallback). Used by FilePreviewApp where the input is always a real
// markdown file — none of MessageContent's chat-specific branches apply.
// MessageContent.jsx still owns the chat-bubble rendering with its richer
// link/image handling; we keep them separate so chat changes don't ripple
// into file preview.

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownContent({ text, className = '' }) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{String(text || '')}</ReactMarkdown>
    </div>
  );
}
