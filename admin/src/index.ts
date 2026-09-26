import { jsonError } from './errors';
import { requireAuth } from './auth';
import { handleAdmin } from './routes';
import type { Env } from './types';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname.startsWith('/api/admin/')) {
      if (!requireAuth(req, env)) return jsonError('unauthorized', '需要管理令牌', 401);
      const res = await handleAdmin(req, u, env); // 返回 null = 非 admin 端点（当前不存在），继续往下
      if (res) return res;
    }
    // 其余路由表后续任务填充（Task 10 扩展兼容层 / notifications；静态资源走 Assets）
    return new Response('ok');
  },
};
