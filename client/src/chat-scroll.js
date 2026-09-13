export const CHAT_BOTTOM_THRESHOLD_PX = 96;

export function isNearChatBottom(pane, threshold = CHAT_BOTTOM_THRESHOLD_PX) {
  if (!pane) {
    return true;
  }
  const scrollHeight = Number(pane.scrollHeight) || 0;
  const scrollTop = Number(pane.scrollTop) || 0;
  const clientHeight = Number(pane.clientHeight) || 0;
  return scrollHeight - scrollTop - clientHeight < threshold;
}

export function shouldFollowChatOutput({ pinnedToBottom, pinnedBeforeUpdate = false, force = false }) {
  return Boolean(force || pinnedToBottom || pinnedBeforeUpdate);
}
