export function normalizeActivityText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function messageMatchesAnyRunKey(message, keys) {
  if (!keys.size) {
    return false;
  }
  return [message.turnId, message.sessionId, message.previousSessionId]
    .filter(Boolean)
    .some((key) => keys.has(String(key)));
}

export function removeDuplicateFinalAnswerActivity(messages, payload = {}) {
  const finalText = normalizeActivityText(payload.content || payload.label || '');
  if (!finalText) {
    return messages;
  }
  const keys = new Set([payload.turnId, payload.sessionId, payload.previousSessionId].filter(Boolean).map(String));
  if (!keys.size) {
    return messages;
  }

  return (messages || []).map((message) => {
    if (message?.role !== 'activity' || !Array.isArray(message.activities) || !messageMatchesAnyRunKey(message, keys)) {
      return message;
    }
    return {
      ...message,
      activities: message.activities.filter((activity) => {
        if (!['agent_message', 'message'].includes(activity?.kind)) {
          return true;
        }
        return normalizeActivityText(activity.label || activity.content || activity.detail) !== finalText;
      })
    };
  });
}
