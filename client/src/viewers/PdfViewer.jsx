// PDF viewer — thin wrapper around PdfPreview so the shell mounts it via
// the same { id, loader, Component } contract every other viewer uses.

import { PdfPreview } from '../app/PdfPreview.jsx';

function matches(pathLower, contentTypeLower) {
  if (contentTypeLower.includes('pdf')) return true;
  return /\.pdf(?:$|[:?#])/i.test(pathLower);
}

async function loader(blob) {
  const data = await blob.arrayBuffer();
  return { data };
}

function Component({ data, fileUrl }) {
  return <PdfPreview data={data} fileUrl={fileUrl || ''} />;
}

export const PdfViewer = {
  id: 'pdf',
  matches,
  loader,
  Component,
  toolbar: 'pdf',
  capabilities: { canEdit: false, canAdjustFont: false }
};
