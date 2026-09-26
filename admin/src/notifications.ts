// GET /api/notifications（spec §6:137 公开只读；§11「只暴露本就公开展示的数据」）：
// 最近 20 条 published，形状对齐前台 component_header.js 消费（title/description/url + timestamp 取 latest）。
// timestamp = updated_at 的 ISO 化（附录 A 已知妥协：无独立发布时间表，updated_at 即发布/更新时刻）。

import { jsonError } from './errors';
import type { Env, SiteRow } from './types';

// 'YYYY-MM-DD HH:MM:SS'（sqlite datetime('now')）→ 'YYYY-MM-DDTHH:MM:SSZ'；已是 ISO/异常值原样透出
export const toIso = (s: string): string => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);

export async function handleNotifications(req: Request, u: URL, env: Env): Promise<Response | null> {
  if (u.pathname !== '/api/notifications') return null;
  if (req.method !== 'GET') return jsonError('bad_request', '方法不支持', 400);
  try {
    const { results } = await env.DB
      .prepare(`SELECT * FROM sites WHERE status = 'published' ORDER BY updated_at DESC LIMIT 20`)
      .all<SiteRow>();
    return Response.json(
      results.map((r) => ({ title: r.title, description: r.description, url: r.url_raw || r.url, timestamp: toIso(r.updated_at) })),
    );
  } catch (e) {
    console.error('notifications failed:', e);
    return jsonError('fetch_failed', '服务器内部错误', 500);
  }
}
