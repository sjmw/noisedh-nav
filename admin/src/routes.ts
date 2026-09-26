// /api/admin/* 核心路由（spec §6，含 Task 8 接入的 POST /api/admin/publish）。
// 约定：handleAdmin 仅在「路径不属于 /api/admin/」时返回 null（index.ts 继续往下分发）；
// 属于 /api/admin/ 但未匹配到端点 → 404 jsonError。鉴权由 index.ts 在进入前统一 requireAuth。
// 响应壳：单行 {site}、列表 {sites,total,page,perPage}、分类 {categories}；错误一律 {error,message}。

import { parseChromeBookmarks } from './bookmarks';
import { analyzeAndUpsert } from './pipeline';
import { doPublish } from './publish';
import { jsonError } from './errors';
import {
  listSites, getSiteById, insertSite, updateSite, deleteSite,
  allCategories, upsertCategory, deleteCategory,
} from './db';
import type { SitePatch } from './db';
import type { Env, SiteRow } from './types';
import type { ErrCode } from './errors';

// 导入体积闸（spec §4.1：输入上限 10MB）——按「解码后的 html 字符串」的 UTF-8 字节数计，
// 而非 JSON 请求体：JSON 转义（\" 等）会膨胀体积，按 body 计会让实际可用的 html 低于名义上限。
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const IMPORT_CONCURRENCY = 3;
const PATCH_FIELDS = ['title', 'description', 'logo', 'taxonomy', 'term', 'status', 'sort'] as const;

const json = (data: unknown, status = 200): Response => Response.json(data, { status });

const errByCode: Record<ErrCode, number> = {
  unauthorized: 401, bad_request: 400, dup_url: 409, fetch_failed: 502,
  ai_invalid: 502, github_conflict: 409, too_large: 413,
};
function fail(code: ErrCode, message: string): Response {
  return jsonError(code, message, errByCode[code]);
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await req.json();
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// spec §8 统一错误外壳：路由体内任何逃逸异常 → 500 {error,message} JSON（而非 Cloudflare 纯文本）。
// code 枚举固定 7 项、无 internal/server 类 code，取语义最近的 fetch_failed 承载「上游/内部失败」，状态用 500（见报告说明）。
export async function handleAdmin(req: Request, u: URL, env: Env): Promise<Response | null> {
  try {
    return await routeAdmin(req, u, env);
  } catch (e) {
    console.error('admin route unhandled error:', u.pathname, e);
    return jsonError('fetch_failed', '服务器内部错误', 500);
  }
}

async function routeAdmin(req: Request, u: URL, env: Env): Promise<Response | null> {
  const p = u.pathname;
  if (!p.startsWith('/api/admin/')) return null;
  const db = env.DB;

  // ── sites 集合 ──
  if (p === '/api/admin/sites' && req.method === 'GET') {
    const num = (name: string): number | undefined => {
      const raw = u.searchParams.get(name);
      if (raw === null || raw === '') return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? Math.trunc(n) : undefined;
    };
    const str = (name: string): string | undefined => u.searchParams.get(name) ?? undefined;
    const page = Math.max(1, num('page') ?? 1);
    const perPageRaw = num('perPage');
    const perPage = perPageRaw === undefined ? undefined : Math.min(200, Math.max(1, perPageRaw));
    const { rows, total } = await listSites(db, {
      status: str('status'), q: str('q'), taxonomy: str('taxonomy'), page, perPage,
    });
    return json({ sites: rows, total, page, perPage: perPage ?? 50 });
  }
  if (p === '/api/admin/sites' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body || typeof body.url !== 'string') return fail('bad_request', '需要 JSON {url:string}');
    const pick = (k: 'title' | 'description' | 'taxonomy' | 'term' | 'logo'): string | undefined =>
      typeof body[k] === 'string' ? (body[k] as string) : undefined;
    const r = await analyzeAndUpsert(
      { url: body.url, title: pick('title'), description: pick('description'), taxonomy: pick('taxonomy'), term: pick('term'), logo: pick('logo'), source: 'manual' },
      env, db,
    );
    if (!r.ok) return fail(r.code, r.code === 'dup_url' ? '该 URL 已存在' : '分析入库失败');
    return json({ site: r.row }, 201);
  }

  // ── 书签批量导入 ──
  if (p === '/api/admin/import' && req.method === 'POST') {
    let body: Record<string, unknown> | null = null;
    try {
      const v: unknown = JSON.parse(await req.text());
      body = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    if (!body || typeof body.html !== 'string' || body.html.trim() === '') return fail('bad_request', '需要 JSON {html:string}');
    // 体积闸按解码后 html 的 UTF-8 字节数计（spec §4.1，10MB）
    if (new TextEncoder().encode(body.html).length > MAX_IMPORT_BYTES) return fail('too_large', 'html 超过 10MB 上限');
    return handleImport(body.html);
  }

  // ── sites/:id 与 sites/:id/analyze ──
  const siteM = /^\/api\/admin\/sites\/([^/]+)(?:\/(analyze))?\/?$/.exec(p);
  if (siteM) {
    if (!/^\d+$/.test(siteM[1]!)) return fail('bad_request', 'id 需为数字'); // 路径形态命中但 id 非法 → 400
    const id = Number(siteM[1]);
    if (siteM[2] === 'analyze') {
      if (req.method !== 'POST') return fail('bad_request', '仅支持 POST');
      return handleReanalyze(id);
    }
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      if (!body) return fail('bad_request', '需要 JSON 对象');
      const patch: Record<string, unknown> = {};
      for (const k of PATCH_FIELDS) if (body[k] !== undefined) patch[k] = body[k]; // 白名单外键忽略（spec §6 未定义其语义，取宽松）
      if (Object.keys(patch).length === 0) return fail('bad_request', '无可更新字段（白名单：' + PATCH_FIELDS.join(',') + '）');
      for (const k of ['title', 'description', 'logo', 'taxonomy', 'term'] as const)
        if (patch[k] !== undefined && typeof patch[k] !== 'string') return fail('bad_request', `${k} 需为字符串`);
      if (patch.status !== undefined && patch.status !== 'pending' && patch.status !== 'published') return fail('bad_request', 'status 仅 pending|published');
      if (patch.sort !== undefined && (typeof patch.sort !== 'number' || !Number.isFinite(patch.sort))) return fail('bad_request', 'sort 需为数字');
      const row = await updateSite(db, id, patch as SitePatch);
      if (!row) return jsonError('bad_request', '站点不存在', 404);
      return json({ site: row });
    }
    if (req.method === 'DELETE') {
      await deleteSite(db, id); // 幂等：不存在也 204
      return new Response(null, { status: 204 });
    }
    return fail('bad_request', '方法不支持');
  }

  // ── categories ──
  if (p === '/api/admin/categories') {
    if (req.method === 'GET') return json({ categories: await allCategories(db) });
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || typeof body.taxonomy !== 'string' || body.taxonomy.trim() === '') return fail('bad_request', '需要 {taxonomy:string,...}');
      const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
      const sort = typeof body.sort === 'number' && Number.isFinite(body.sort) ? Math.trunc(body.sort) : undefined;
      await upsertCategory(db, { taxonomy: body.taxonomy.trim(), term: str(body.term), icon: str(body.icon), sort });
      return new Response(null, { status: 204 });
    }
    if (req.method === 'DELETE') {
      const taxonomy = u.searchParams.get('taxonomy');
      if (!taxonomy) return fail('bad_request', '需要 ?taxonomy=&term=');
      await deleteCategory(db, taxonomy, u.searchParams.get('term') ?? '');
      return new Response(null, { status: 204 });
    }
    return fail('bad_request', '方法不支持');
  }

  // ── Task 8：POST /api/admin/publish（spec §5；鉴权已在 index 层完成）──
  if (p === '/api/admin/publish' && req.method === 'POST') {
    const r = await doPublish(env, db);
    if (!r.ok) return fail(r.code, r.message);
    return json({ commitUrl: r.commitUrl, count: r.count });
  }

  return jsonError('bad_request', '接口不存在', 404); // 路径不属于本表：404（code 枚举无 not_found，取 bad_request 承载）

  async function handleImport(html: string): Promise<Response> {
    const parsed = parseChromeBookmarks(html);
    interface ImportItem { url: string; status: 'added' | 'skipped_dup' | 'failed'; reason: string }
    const items: ImportItem[] = new Array(parsed.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= parsed.length) return;
        const bm = parsed[i]!;
        try {
          const r = await analyzeAndUpsert({ url: bm.url, source: 'import' }, env, db);
          items[i] = r.ok
            ? { url: bm.url, status: 'added', reason: '' }
            : { url: bm.url, status: r.code === 'dup_url' ? 'skipped_dup' : 'failed', reason: r.code };
        } catch (e) {
          console.error('import item failed:', bm.url, e); // 单条异常不拖垮整批
          items[i] = { url: bm.url, status: 'failed', reason: 'error' };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, parsed.length) }, worker));
    return json({
      added: items.filter((i) => i.status === 'added').length,
      skipped_dup: items.filter((i) => i.status === 'skipped_dup').length,
      failed: items.filter((i) => i.status === 'failed').length,
      items,
    });
  }

  async function handleReanalyze(id: number): Promise<Response> {
    const orig = await getSiteById(db, id);
    if (!orig) return jsonError('bad_request', '站点不存在', 404);
    // 流水线带 UNIQUE(url) 查重：先删原行腾位；失败路径（含异常）回滚原行
    await deleteSite(db, id);
    const restore = async (): Promise<void> => {
      try {
        const { id: _i, created_at: _c, updated_at: _u, ...cols } = orig;
        await insertSite(db, cols);
      } catch (e) {
        // 回滚自身也可能 UNIQUE 冲突（如新行已插入后 updateSite 才抛）——此处只记录，不再抛出，保证统一返回错误信封
        console.error('reanalyze rollback failed:', id, e);
      }
    };
    try {
      const r = await analyzeAndUpsert({ url: orig.url, source: orig.source }, env, db);
      if (!r.ok) {
        await restore();
        return fail(r.code, '重新分析失败');
      }
      // 重分析不改发布状态与排序（人工确认语义由 PATCH/publish 承担）
      const kept: SiteRow = (await updateSite(db, r.row.id, { status: orig.status, sort: orig.sort })) ?? r.row;
      return json({ site: kept });
    } catch (e) {
      // analyzeAndUpsert/回写阶段抛异常：原行已删，必须先回滚再报 502（code 枚举无 internal，取 fetch_failed 承载内部失败）
      await restore();
      console.error('reanalyze threw:', id, e);
      return fail('fetch_failed', '重新分析失败');
    }
  }
}
