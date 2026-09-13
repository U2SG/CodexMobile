// Renders a single message's content: plain inline-linked text for user
// messages, ReactMarkdown for assistant messages. Inline images that match
// /generated/* are routed through GeneratedImage instead of a plain <img>.
//
// Extracted from App.jsx (Batch B R9).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { GeneratedImage } from './GeneratedImage.jsx';
import { copyTextToClipboard } from '../utils/clipboard.js';
import { resolveViewerById } from '../viewers/index.js';

function normalizeInlineHref(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (/^https?:\/\//i.test(raw) || /^mailto:/i.test(raw)) {
    return raw;
  }
  return `https://${raw}`;
}

function renderInlineText(text, keyPrefix) {
  const value = String(text || '');
  const pattern = /\[([^\]]+)\]\(((?:https?:\/\/|www\.)[^\s)]+)\)|((?:https?:\/\/|www\.)[^\s<>()]+)/gi;
  const nodes = [];
  let lastIndex = 0;
  let match;
  let partIndex = 0;

  while ((match = pattern.exec(value))) {
    if (match.index > lastIndex) {
      nodes.push(<span key={`${keyPrefix}-text-${partIndex++}`}>{value.slice(lastIndex, match.index)}</span>);
    }

    if (match[1] && match[2]) {
      const href = normalizeInlineHref(match[2]);
      nodes.push(
        <a key={`${keyPrefix}-link-${partIndex++}`} href={href} target="_blank" rel="noreferrer noopener">
          {match[1]}
        </a>
      );
    } else if (match[3]) {
      const href = normalizeInlineHref(match[3]);
      nodes.push(
        <a key={`${keyPrefix}-link-${partIndex++}`} href={href} target="_blank" rel="noreferrer noopener">
          {match[3]}
        </a>
      );
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < value.length) {
    nodes.push(<span key={`${keyPrefix}-text-${partIndex++}`}>{value.slice(lastIndex)}</span>);
  }

  return nodes.length ? nodes : [<span key={`${keyPrefix}-text-0`}>{value}</span>];
}

function languageLabel(className) {
  const match = /language-([a-z0-9_+-]+)/i.exec(String(className || ''));
  return match?.[1] || 'text';
}

function CodeBlock({ className, children }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  const code = String(children || '').replace(/\n$/, '');
  const language = languageLabel(className);

  useEffect(() => () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }
  }, []);

  async function handleCopy() {
    const ok = await copyTextToClipboard(code);
    if (!ok) {
      window.alert('\u590d\u5236\u5931\u8d25');
      return;
    }
    setCopied(true);
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <figure className="message-code-shell">
      <figcaption className="message-code-toolbar">
        <span>{language}</span>
        <button type="button" onClick={handleCopy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? '\u5df2\u590d\u5236' : '\u590d\u5236'}</span>
        </button>
      </figcaption>
      <pre className="message-code-block">
        <code className={className}>{code}</code>
      </pre>
    </figure>
  );
}

export function MessageContent({ content, onPreviewImage, isUser }) {
  const text = String(content || '');

  // Rebuilding markdownComponents on every render replaces ReactMarkdown's
  // component types each pass, which would unmount/remount CodeBlock and
  // erase its `copied` flash before the timer can fire. Memoize so the
  // component table only changes when onPreviewImage does.
  const markdownComponents = useMemo(() => ({
    img: ({ src, alt, title }) => {
      const url = String(src || '');
      if (url.startsWith('/generated/')) {
        return <GeneratedImage part={{ url, alt: alt || '\u751f\u6210\u56fe\u7247' }} onPreviewImage={onPreviewImage} />;
      }
      return <img src={url} alt={alt || ''} title={title || ''} loading="lazy" />;
    },
    a: ({ href, children, ...rest }) => (
      <a href={normalizeInlineHref(href || '')} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    ),
    table: ({ children, ...rest }) => (
      <div className="message-table-wrap">
        <table {...rest}>{children}</table>
      </div>
    ),
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children, ...rest }) => {
      const value = String(children || '');
      if (!className && !value.includes('\n')) {
        return <code className={className} {...rest}>{children}</code>;
      }
      // ```viewer:<id> fenced block → mount the registered viewer inline
      // (only for viewers that opted in via capabilities.acceptsInline,
      // which excludes image/pdf — those need a Blob, not raw text).
      // Different markdown libs normalize the `:` in the info-string;
      // accept both `viewer:markdown` and `viewer-markdown` in className.
      const viewerMatch = /^language-viewer[:_-]([a-z0-9_+-]+)$/i.exec(String(className || ''));
      if (viewerMatch) {
        const viewer = resolveViewerById(viewerMatch[1]);
        if (viewer?.capabilities?.acceptsInline) {
          const Component = viewer.Component;
          return (
            <div className="message-inline-viewer" data-viewer-id={viewer.id}>
              <Component text={value.replace(/\n$/, '')} mode="rendered" />
            </div>
          );
        }
        // unknown / non-inline viewer id — fall through to CodeBlock so
        // the raw text is still visible.
      }
      return <CodeBlock className={className} {...rest}>{children}</CodeBlock>;
    }
  }), [onPreviewImage]);

  if (isUser) {
    return <div className="message-content is-plain">{renderInlineText(text, 'message-root')}</div>;
  }

  return (
    <div className="message-content is-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
