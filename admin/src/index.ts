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
    // /admin 与 /admin/ → 改写为源根 /index.html 由 Assets 呈现（非重定向）。
    // 机制说明：Assets 默认「命中即直出、未命中进 Worker」，public/admin/index.html 重复副本解除后
    // /admin 不再命中任何资产，请求天然到达 Worker——无需 run_worker_first，Worker 以 env.ASSETS
    // 抓取 /index.html 原文返回。页面脚本与 API 全按源根绝对路径引用（/admin.js、/api/…），
    // 挂在 / 或 /admin/ 两处同源同形（见 public/index.html 尾部注释）。/ 由资产直出，不走此分支。
    if ((u.pathname === '/admin' || u.pathname === '/admin/') && (req.method === 'GET' || req.method === 'HEAD') && env.ASSETS) {
      const res = await env.ASSETS.fetch(new Request(`${u.origin}/index.html`, { method: req.method }));
      if (res.ok) return res;
    }
    // 未匹配任何 API/资产/改写的兜底：真 404（spec §8 统一 {error,message} JSON 外壳；
    // code 枚举无 not_found，取 bad_request 承载，与 routes/extension 的 404 口径一致）。
    // Task 12 前这里是 200 'ok' 占位，属占位语义残留，已废除（routes.test.ts 同步适配）。
    return jsonError('bad_request', '路径不存在', 404);
  },
};
