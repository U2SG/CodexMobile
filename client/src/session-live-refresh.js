import { sameUserMessageContent } from './chat/message-identity.js';

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isPendingLocalMessage(message) {
  const id = String(message?.id || '');
  if (id.startsWith('local-')) {
    return true;
  }
  return message?.role === 'activity' && ['running', 'queued'].includes(String(message?.status || ''));
}

function messageRunKeys(message) {
  return [message?.turnId, message?.sessionId, message?.previousSessionId].filter(Boolean).map(String);
}

function messageMatchesRunKeys(message, keys) {
  if (!keys.size) {
    return false;
  }
  return messageRunKeys(message).some((key) => keys.has(key));
}

function loadedHasAssistantForActivity(loaded, activity) {
  const keys = new Set(messageRunKeys(activity));
  if (!keys.size) {
    return false;
  }
  return loaded.some((item) => item?.role === 'assistant' && messageMatchesRunKeys(item, keys) && normalizeText(item.content));
}

function completeLocalActivityMessage(message, loaded = []) {
  const keys = new Set(messageRunKeys(message));
  const assistant = loaded.find((item) => item?.role === 'assistant' && messageMatchesRunKeys(item, keys) && normalizeText(item.content));
  if (!assistant && !['running', 'queued'].includes(String(message?.status || ''))) {
    return message;
  }
  return {
    ...message,
    status: message.status === 'failed' ? 'failed' : 'completed',
    label: message.status === 'failed' ? message.label : '过程已同步',
    content: message.status === 'failed' ? message.content : '过程已同步',
    completedAt: message.completedAt || assistant?.timestamp || new Date().toISOString(),
    activities: Array.isArray(message.activities)
      ? message.activities.map((activity) =>
        ['running', 'queued'].includes(String(activity?.status || ''))
          ? { ...activity, status: 'completed' }
          : activity
      )
      : message.activities
  };
}

function activityInsertIndex(loaded, activity) {
  const keys = new Set(messageRunKeys(activity));
  const index = loaded.findIndex((message) => message?.role === 'assistant' && messageMatchesRunKeys(message, keys));
  return index >= 0 ? index : loaded.length;
}

function preserveLocalActivityMessages(current = [], loaded = []) {
  const loadedIds = new Set(loaded.map((message) => String(message?.id || '')).filter(Boolean));
  const preserved = current
    .filter((message) => message?.role === 'activity' && !loadedIds.has(String(message?.id || '')))
    .filter((message) => {
      const keys = new Set(messageRunKeys(message));
      if (!keys.size) {
        return false;
      }
      if (loaded.some((item) => item?.role === 'activity' && messageMatchesRunKeys(item, keys))) {
        return false;
      }
      if (message?.transient && loadedHasAssistantForActivity(loaded, message)) {
        return false;
      }
      return loaded.some((item) => messageMatchesRunKeys(item, keys)) || ['running', 'queued'].includes(String(message?.status || ''));
    })
    .map((message) =>
      message?.transient
        ? message
        : completeLocalActivityMessage(message, loaded)
    );

  if (!preserved.length) {
    return loaded;
  }

  const result = [...loaded];
  for (const activity of preserved.sort((a, b) => activityInsertIndex(result, a) - activityInsertIndex(result, b))) {
    result.splice(activityInsertIndex(result, activity), 0, activity);
  }
  return result;
}

function desktopBridgeUsesExternalThreadRefresh(bridge = null) {
  return Boolean(bridge?.connected && ['desktop-ipc', 'headless-local'].includes(bridge?.mode));
}

export function shouldPollSelectedSessionMessages({
  hasSelectedRunning = false,
  desktopBridge = null,
  hasExternalThreadRefresh = false
} = {}) {
  if (!hasSelectedRunning) {
    return true;
  }
  return desktopBridgeUsesExternalThreadRefresh(desktopBridge) && Boolean(hasExternalThreadRefresh);
}

export function mergeLiveSelectedThreadMessages(current = [], loaded = []) {
  if (!Array.isArray(loaded)) {
    return Array.isArray(current) ? current : [];
  }
  if (!Array.isArray(current) || !current.length) {
    return loaded;
  }

  const loadedUsers = loaded.filter((message) => message?.role === 'user');
  const hasUncaughtLocalUser = current.some((message) =>
    message?.role === 'user' &&
    isPendingLocalMessage(message) &&
    !loadedUsers.some((loadedMessage) => sameUserMessageContent(message.content, loadedMessage.content))
  );

  if (!hasUncaughtLocalUser) {
    return preserveLocalActivityMessages(current, loaded);
  }

  const loadedIds = new Set(loaded.map((message) => String(message?.id || '')).filter(Boolean));
  const pending = current.filter((message) => {
    if (!isPendingLocalMessage(message)) {
      return false;
    }
    if (loadedIds.has(String(message?.id || ''))) {
      return false;
    }
    if (message?.role === 'user' && loadedUsers.some((loadedMessage) => sameUserMessageContent(message.content, loadedMessage.content))) {
      return false;
    }
    return true;
  });

  return preserveLocalActivityMessages(current, [...loaded, ...pending]).sort(
    (a, b) => new Date(a?.timestamp || 0).getTime() - new Date(b?.timestamp || 0).getTime()
  );
}
