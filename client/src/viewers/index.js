// Barrel for the viewer registry. Importing this module registers all
// shipped viewers in the order they should be tried.
//
// Order matters: viewer-registry walks the list and picks the first
// `matches()` hit. Specific kinds (markdown, image, pdf) come before
// the generic text catch-all, and Download is last as the safety net.

import { registerViewer } from './viewer-registry.js';
import { MarkdownViewer } from './MarkdownViewer.jsx';
import { ImageViewer } from './ImageViewer.jsx';
import { PdfViewer } from './PdfViewer.jsx';
import { JsonViewer } from './JsonViewer.jsx';
import { TextViewer } from './TextViewer.jsx';
import { DownloadViewer } from './DownloadViewer.jsx';

// Order is significant — first matches() hit wins. JSON registers before
// Text so `.json` files route to the tree viewer instead of the plain
// <pre> renderer. (TextViewer's extension list still includes `.json`
// as a backstop in case JsonViewer is removed.)
registerViewer(MarkdownViewer);
registerViewer(ImageViewer);
registerViewer(PdfViewer);
registerViewer(JsonViewer);
registerViewer(TextViewer);
registerViewer(DownloadViewer);

export { resolveViewer, resolveViewerById, listViewers } from './viewer-registry.js';
export { MarkdownViewer, ImageViewer, PdfViewer, JsonViewer, TextViewer, DownloadViewer };
