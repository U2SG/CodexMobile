// useImageIntentResolver — owns the handler invoked when the user clicks one
// of the three buttons in the image-intent confirmation strip
// (cancel / generate-anyway / send-as-text). Pulled out as Batch G R17.
//
// Pure refactor: same `submitCodexMessage` call with imageMode, same
// "restore pending to composer" recovery on cancel and on submit failure.
//
// The mode → submit-decision mapping is exposed as
// `interpretImageIntentResolution` so the three button outcomes can be
// asserted without invoking the submission pipeline.
//
// Inputs:
//   imageIntentConfirmation     — pending confirmation payload from
//                                 useTurnSubmission (or null if no pending)
//   selectedSessionRef          — passed through to loadQueueDrafts after a
//                                 successful submit so the queue panel
//                                 reflects the new state
//   setImageIntentConfirmation  — clears the confirmation strip the moment
//                                 the user makes a choice
//   setInput, setAttachments    — composer restorers used on cancel + on
//                                 submit failure (so the user can retry)
//   submitCodexMessage          — from useTurnSubmission
//   loadQueueDrafts             — from useQueueDrafts
//
// Returns:
//   { handleResolveImageIntent }

// Pure helper: map the three confirmation modes to a structured decision.
// 'cancel' → restore composer; 'force' → submit with imageMode 'force';
// anything else (including 'skip' / unknown strings) → submit with 'skip'.
export function interpretImageIntentResolution(mode) {
  if (mode === 'cancel') {
    return { action: 'cancel' };
  }
  return {
    action: 'submit',
    imageMode: mode === 'force' ? 'force' : 'skip'
  };
}

export function useImageIntentResolver({
  imageIntentConfirmation,
  selectedSessionRef,
  setImageIntentConfirmation,
  setInput,
  setAttachments,
  submitCodexMessage,
  loadQueueDrafts
}) {
  function restorePending(pending) {
    setInput(pending.message || '');
    setAttachments(pending.attachments || []);
  }

  async function handleResolveImageIntent(mode) {
    const pending = imageIntentConfirmation;
    if (!pending) {
      return;
    }
    setImageIntentConfirmation(null);
    const decision = interpretImageIntentResolution(mode);
    if (decision.action === 'cancel') {
      restorePending(pending);
      return;
    }
    try {
      await submitCodexMessage({
        message: pending.message,
        attachmentsForTurn: pending.attachments || [],
        sendMode: pending.sendMode,
        imageMode: decision.imageMode
      });
      loadQueueDrafts(selectedSessionRef.current);
    } catch {
      restorePending(pending);
    }
  }

  return { handleResolveImageIntent };
}
