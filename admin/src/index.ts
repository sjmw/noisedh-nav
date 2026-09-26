import { jsonError } from './errors';
import { requireAuth } from './auth';
import { handleAdmin } from './routes';
import { handleExtension } from './extension';
import { handleNotifications } from './notifications';
import type { Env } from './types';

// 扩展兼容层写接口（附录 A 标 Bearer 的三个）在 index 层统一 requireAuth，与 /api/admin/* 同一口径
// （spec §6:125 写面鉴权 + §11:170「不新增任何匿名写接口」）。
// 公开读接口：/data*、/api/search（popup.js:597/605/1311 不发 Authorization 头）、
// /api/notifications（spec §6:137 明示「公开（只读）」，前台 component_header.js 无 token 调用）。
const EXT_AUTHED = ['/api/yaml', '/api/delete', '/api/server-settings'];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname.startsWith('/api/admin/')) {
      if (!requireAuth(req, env)) return jsonError('unauthorized', '需要管理令牌', 401);
      const res = await handleAdmin(req, u, env); // 返回 null = 非 admin 端点（当前不存在），继续往下
      if (res) return res;
    }
    if (EXT_AUTHED.includes(u.pathname) && !requireAuth(req, env)) {
      return jsonError('unauthorized', '需要管理令牌', 401);
    }
    const ext = (await handleExtension(req, u, env)) ?? (await handleNotifications(req, u, env));
    if (ext) return ext;
    // 其余路径交回 Assets（管理页/静态资源）；无资产命中时兜底 ok（Task 7 既有测试口径）
    return new Response('ok');
  },
};
