// Image viewer — previously images fell through to the generic Download
// fallback (an "open file" link). Render them inline instead. The shell
// passes the Blob-derived object URL.

const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico|heic|heif)(?:$|[:?#])/i;

function matches(pathLower, contentTypeLower) {
  if (contentTypeLower.startsWith('image/')) return true;
  return IMAGE_EXTENSIONS.test(pathLower);
}

async function loader(blob) {
  // Caller (FilePreview shell) is responsible for revoking this URL on
  // unmount — it threads cleanup through the same path it already uses
  // for the download fallback.
  const objectUrl = URL.createObjectURL(blob);
  return { objectUrl };
}

function Component({ objectUrl }) {
  if (!objectUrl) return null;
  // Reuses `.message-image` from styles.css (display:block + max-height
  // min(54vh,520px) + object-fit:contain) so the file preview matches
  // how chat-inline images render.
  return <img src={objectUrl} alt="" className="message-image" />;
}

export const ImageViewer = {
  id: 'image',
  matches,
  loader,
  Component,
  toolbar: 'image',
  capabilities: { canEdit: false, canAdjustFont: false }
};
