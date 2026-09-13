import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// Temporary diagnostic overlay: surface any startup error onto the page
// itself when the chat shell would otherwise render to a blank screen.
function paintErrorOverlay(label, error) {
  try {
    const root = document.getElementById('root');
    if (!root) return;
    const detail = error && (error.stack || error.message || String(error));
    root.innerHTML = `<pre style="position:fixed;inset:0;margin:0;padding:16px;font:12px/1.4 monospace;color:#b00020;background:#fff;overflow:auto;white-space:pre-wrap;z-index:99999">[boot ${label}] ${detail || 'unknown error'}</pre>`;
  } catch (_) {
    /* last-resort: nothing else to do */
  }
}
window.addEventListener('error', (event) => paintErrorOverlay('error', event.error || event.message));
window.addEventListener('unhandledrejection', (event) => paintErrorOverlay('unhandled', event.reason));

const root = createRoot(document.getElementById('root'));

if (window.location.pathname === '/preview/file') {
  import('./app/FilePreviewApp.jsx').then(({ default: FilePreviewApp }) => {
    root.render(
      <React.StrictMode>
        <FilePreviewApp />
      </React.StrictMode>
    );
  });
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
