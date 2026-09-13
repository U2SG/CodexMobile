// Catch-all viewer for binary / unknown types. Just exposes an "open
// in new tab" link backed by the Blob's object URL.

import { ExternalLink } from 'lucide-react';

function matches() {
  // Last-resort fallback — must remain at the end of the registration
  // list so other viewers get first crack.
  return true;
}

async function loader(blob) {
  const objectUrl = URL.createObjectURL(blob);
  return { objectUrl };
}

function Component({ objectUrl }) {
  if (!objectUrl) return null;
  return (
    <a className="file-preview-open" href={objectUrl} target="_blank" rel="noreferrer noopener">
      <ExternalLink size={16} />
      <span>打开文件</span>
    </a>
  );
}

export const DownloadViewer = {
  id: 'download',
  matches,
  loader,
  Component,
  toolbar: 'download',
  capabilities: { canEdit: false, canAdjustFont: false }
};
