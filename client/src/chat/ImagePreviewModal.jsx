// Full-screen lightbox preview for an image. Tapping the backdrop closes;
// tapping the image itself does not (stopPropagation on the stage). On
// load failure a "重新加载" button re-triggers the cache-buster via the
// shared imageUrlWithRetry helper.
//
// Extracted from App.jsx (Batch B R4) verbatim — behaviour unchanged.

import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { imageUrlWithRetry } from './image-url.js';

export function ImagePreviewModal({ image, onClose }) {
  const [loadState, setLoadState] = useState('loading');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    setLoadState('loading');
    setRetryKey(0);
  }, [image?.url]);

  if (!image) {
    return null;
  }

  const src = imageUrlWithRetry(image.url, retryKey);

  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="lightbox-top">
        <button type="button" className="lightbox-close" onClick={onClose} aria-label="关闭图片预览">
          <X size={22} />
        </button>
      </div>
      <div className="lightbox-stage" onClick={(event) => event.stopPropagation()}>
        <img
          src={src}
          alt={image.alt || '生成图片'}
          onLoad={() => setLoadState('loaded')}
          onError={() => setLoadState('failed')}
        />
      </div>
      {loadState === 'failed' ? (
        <div className="lightbox-actions" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            onClick={() => {
              setLoadState('loading');
              setRetryKey(Date.now());
            }}
          >
            <RefreshCw size={16} />
            重新加载
          </button>
        </div>
      ) : null}
    </div>
  );
}
