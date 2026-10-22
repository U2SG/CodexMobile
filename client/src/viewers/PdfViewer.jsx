// PDF viewer — thin wrapper around PdfPreview so the shell mounts it via
// the same { id, loader, Component } contract every other viewer uses.

import { lazy } from 'react';
import { LazyBoundary } from '../LazyBoundary.jsx';

// pdfjs is large; load it only when a PDF is actually opened.
const PdfPreview = lazy(() => import('../app/PdfPreview.jsx').then((module) => ({ default: module.PdfPreview })));

function matches(pathLower, contentTypeLower) {
  if (contentTypeLower.includes('pdf')) return true;
  return /\.pdf(?:$|[:?#])/i.test(pathLower);
}

async function loader(blob) {
  const data = await blob.arrayBuffer();
  return { data };
}

function Component({ data, fileUrl }) {
  return (
    <LazyBoundary>
      <PdfPreview data={data} fileUrl={fileUrl || ''} />
    </LazyBoundary>
  );
}

export const PdfViewer = {
  id: 'pdf',
  matches,
  loader,
  Component,
  toolbar: 'pdf',
  capabilities: { canEdit: false, canAdjustFont: false }
};
