// Inline image renderer for assistant-generated bitmap output.
//
// Lazy <img> with two failure modes:
//   * onLoad → 'loaded' (default click opens the lightbox via onPreviewImage).
//   * onError → 'failed' (click swaps the cache-buster and re-fetches; if it
//     succeeds, state flips back to 'loaded'; if it fails again, the failed
//     overlay stays).
//
// Extracted from App.jsx to shrink the 5500-line monolith and as Batch B's
// first JSX-extraction round under the new atomic-commit protocol. Behaviour
// is unchanged from the inline version.

import { useState } from 'react';
import { imageUrlWithRetry } from './image-url.js';

export function GeneratedImage({ part, onPreviewImage }) {
  const [loadState, setLoadState] = useState('loading');
  const [retryKey, setRetryKey] = useState(0);
  const src = imageUrlWithRetry(part.url, retryKey);

  function retry(event) {
    event.stopPropagation();
    setLoadState('loading');
    setRetryKey(Date.now());
  }

  return (
    <button
      type="button"
      className={`message-image-link ${loadState === 'failed' ? 'is-failed' : ''}`}
      onClick={() => (loadState === 'failed' ? setRetryKey(Date.now()) : onPreviewImage(part))}
      aria-label="预览图片"
    >
      <img
        className="message-image"
        src={src}
        alt={part.alt}
        loading="eager"
        decoding="async"
        onLoad={() => setLoadState('loaded')}
        onError={() => setLoadState('failed')}
      />
      {loadState === 'failed' ? (
        <span className="image-error">
          图片加载失败
          <span onClick={retry}>重试</span>
        </span>
      ) : null}
    </button>
  );
}
