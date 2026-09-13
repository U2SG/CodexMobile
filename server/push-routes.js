import { readBody, sendJson } from './http-utils.js';

const TEST_NOTIFICATION = {
  level: 'info',
  title: 'CodexMobile 测试通知',
  body: '如果你看到这条消息，Web Push 已经配置成功。'
};

export function createPushRoutes({ pushService } = {}) {
  if (!pushService) throw new Error('createPushRoutes: pushService is required');

  async function handleError(res, error, fallback) {
    const status = error.statusCode || 500;
    sendJson(res, status, { error: error.message || fallback });
  }

  return async function handle(req, res, ctx) {
    const { method, pathname } = ctx;

    if (pathname === '/api/notifications/status') {
      if (method !== 'GET') return false;
      try {
        const status = await pushService.publicStatus();
        sendJson(res, 200, status);
      } catch (error) {
        await handleError(res, error, 'Failed to read push status');
      }
      return true;
    }

    if (pathname === '/api/notifications/subscribe') {
      if (method !== 'POST') return false;
      try {
        const body = await readBody(req).catch(() => ({}));
        const userAgent = req.headers?.['user-agent'] || null;
        const subscription = await pushService.subscribe(body, { userAgent });
        sendJson(res, 200, { success: true, subscription });
      } catch (error) {
        await handleError(res, error, 'Failed to subscribe');
      }
      return true;
    }

    if (pathname === '/api/notifications/unsubscribe') {
      if (method !== 'POST') return false;
      try {
        const body = await readBody(req).catch(() => ({}));
        const result = await pushService.unsubscribe(body?.endpoint);
        sendJson(res, 200, result);
      } catch (error) {
        await handleError(res, error, 'Failed to unsubscribe');
      }
      return true;
    }

    if (pathname === '/api/notifications/test') {
      if (method !== 'POST') return false;
      if (process.env.NODE_ENV === 'production') {
        sendJson(res, 404, { error: 'Not found' });
        return true;
      }
      try {
        const result = await pushService.sendNotification(TEST_NOTIFICATION);
        sendJson(res, 200, { success: true, ...result });
      } catch (error) {
        await handleError(res, error, 'Failed to send test notification');
      }
      return true;
    }

    return false;
  };
}
