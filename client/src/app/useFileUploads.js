// useFileUploads — owns the composer's attachment list and upload flow.
// Pulled out of App.jsx as a pure refactor (Stage 2 R2): same logic, same
// behavior; just localizes the state + handlers so callers don't reach into
// random pieces of App body.
//
// Returns:
//   attachments              — current pending-attachment list (passed to Composer)
//   setAttachments           — direct setter (callers reset on send / session switch /
//                              pre-fill when re-sending; left exposed because App
//                              already has multiple call sites that need it)
//   uploading                — boolean (passed to Composer for the send-button mode)
//   handleUploadFiles(files) — POST each File to /api/uploads; appends successful
//                              uploads to `attachments`. Drops results if the user
//                              switched sessions mid-upload so an attachment / error
//                              never lands in the wrong conversation.
//   handleRemoveAttachment(id) — drops a pending attachment by id.

import { useState } from 'react';

import { apiFetch } from '../api.js';

export function useFileUploads({ selectedSessionRef, setMessages }) {
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);

  async function handleUploadFiles(files) {
    // Capture the conversation the upload was started from. If the user
    // switches sessions mid-upload, neither the attachment nor the error
    // belongs in the new conversation.
    const startedInSessionId = selectedSessionRef.current?.id || null;
    const stillInOriginatingSession = () =>
      selectedSessionRef.current?.id === startedInSessionId;
    setUploading(true);
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        const result = await apiFetch('/api/uploads', {
          method: 'POST',
          body: formData
        });
        if (stillInOriginatingSession()) {
          setAttachments((current) => [...current, result.upload]);
        }
      }
    } catch (error) {
      if (stillInOriginatingSession()) {
        setMessages((current) => [
          ...current,
          {
            id: `upload-error-${Date.now()}`,
            role: 'activity',
            content: error.message,
            timestamp: new Date().toISOString()
          }
        ]);
      }
    } finally {
      setUploading(false);
    }
  }

  function handleRemoveAttachment(id) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  return {
    attachments,
    setAttachments,
    uploading,
    handleUploadFiles,
    handleRemoveAttachment
  };
}
