// File-related routes. Originally minimal (just /api/files/search) — C3 wired
// in static-service and upload-service so the full /api/local-image,
// /api/local-file (GET + PUT), and /api/uploads surface lives here instead
// of inline in index.js.
//
// Body sizes: GET/PUT local-file uses 6 MB (matches the 5 MB editable cap
// in static-service plus headroom). /api/uploads honors the caller-provided
// maxUploadBytes (defaults to 50 MB in saveUpload).

import { readBody, sendJson } from './http-utils.js';
import { searchProjectFiles as defaultSearchProjectFiles } from './file-search.js';
import { saveUpload as defaultSaveUpload } from './upload-service.js';

export function createFileRouteHandler({
  getProject,
  searchProjectFiles = defaultSearchProjectFiles,
  staticService,
  saveUpload = defaultSaveUpload,
  uploadRoot,
  maxUploadBytes,
  remoteAddress = () => ''
}) {
  if (typeof getProject !== 'function') {
    throw new Error('createFileRouteHandler requires getProject');
  }

  return async function handleFileApi(req, res, url) {
    const method = req.method || 'GET';
    const pathname = url.pathname;
    const localFileRoute = pathname === '/api/local-file' || pathname.startsWith('/api/local-file/');

    if (method === 'GET' && pathname === '/api/local-image' && staticService) {
      await staticService.sendLocalImage(req, res, url);
      return true;
    }

    if (method === 'GET' && localFileRoute && staticService) {
      await staticService.sendLocalFile(req, res, url);
      return true;
    }

    if (method === 'PUT' && localFileRoute && staticService) {
      try {
        const body = await readBody(req, { maxBytes: 6 * 1024 * 1024 });
        await staticService.writeLocalFile(req, res, url, body);
      } catch (error) {
        sendJson(res, error.message === 'Request body too large' ? 413 : 400, {
          error: error.message || 'Invalid request body'
        });
      }
      return true;
    }

    if (method === 'GET' && pathname === '/api/files/search') {
      const project = getProject(url.searchParams.get('projectId') || '');
      if (!project) {
        sendJson(res, 404, { error: 'Project not found' });
        return true;
      }
      try {
        const files = await searchProjectFiles(project, url.searchParams.get('q') || '');
        sendJson(res, 200, { files });
      } catch (error) {
        sendJson(res, error.statusCode || 500, { error: error.message || 'Failed to search files' });
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/uploads') {
      try {
        const upload = await saveUpload(req, { uploadRoot, maxUploadBytes });
        console.log(`[upload] saved name=${upload.name} size=${upload.size} kind=${upload.kind} remote=${remoteAddress(req)}`);
        sendJson(res, 200, { upload });
      } catch (error) {
        const status = error.statusCode || (error.message === 'Upload too large' ? 413 : 400);
        sendJson(res, status, { error: error.message || 'Upload failed' });
      }
      return true;
    }

    return false;
  };
}
