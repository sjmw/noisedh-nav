import { jsonError } from './errors';
import { requireAuth } from './auth';
import type { Env } from './types';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname.startsWith('/api/admin/')) {
      if (!requireAuth(req, env)) return jsonError('unauthorized', '需要管理令牌', 401);
    }
    // 路由表后续任务填充
    return new Response('ok');
  },
};
