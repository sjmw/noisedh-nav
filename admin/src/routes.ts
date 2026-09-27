// /api/admin/* 核心路由（spec §6，含 Task 8 接入的 POST /api/admin/publish）。
// 约定：handleAdmin 仅在「路径不属于 /api/admin/」时返回 null（index.ts 继续往下分发）；
// 属于 /api/admin/ 但未匹配到端点 → 404 jsonError。鉴权由 index.ts 在进入前统一 requireAuth。
// 响应壳：单行 {site}、列表 {sites,total,page,perPage}、分类 {categories}；错误一律 {error,message}。

import { parseChromeBookmarks } from './bookmarks';
import { normalizeUrl } from './url';
import { analyzeAndUpsert } from './pipeline';
import { doPublish } from './publish';
import { jsonError, errStatus, readJsonBody } from './errors';
import { categoryShapePairs, resolveCategoryShape, shapeOfTaxonomy, pruneOrphanCategories } from './category';
import {
  listSites, getSiteById, insertSite, updateSite, deleteSite,
  allCategories, upsertCategory, deleteCategory,
  allFriendlinks, insertFriendlink, updateFriendlink, deleteByIds,
  allNavitems, insertNavitem, updateNavitem, getNavitemById, countNavChildren,
} from './db';
import type { SitePatch } from './db';
import type { Env, SiteRow, NavitemRow } from './types';
import type { ErrCode } from './errors';

// 导入体积闸（spec §4.1：输入上限 10MB）——按「解码后的 html 字符串」的 UTF-8 字节数计，
// 而非 JSON 请求体：JSON 转义（\" 等）会膨胀体积，按 body 计会让实际可用的 html 低于名义上限。
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const IMPORT_CONCURRENCY = 3;
// url/url_raw 入白名单是 Task 9/10 裁定(a) 的 UI 侧要求：行内编辑允许改 URL；
// 展示与导出走 url_raw（缺省回退 url），db 层 MUTABLE 本就放行二者，此处路由层同步放行。
const PATCH_FIELDS = ['url', 'url_raw', 'title', 'description', 'logo', 'taxonomy', 'term', 'status', 'sort'] as const;

const json = (data: unknown, status = 200): Response => Response.json(data, { status });

// errStatus（错误码→HTTP 状态）与 readJsonBody 已收口至 errors.ts（终局评审 minor-5，纯搬移）
function fail(code: ErrCode, message: string): Response {
  return jsonError(code, message, errStatus[code]);
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
      status: str('status'), q: str('q'), taxonomy: str('taxonomy'), term: str('term'), page, perPage,
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
      for (const k of ['url', 'url_raw', 'title', 'description', 'logo', 'taxonomy', 'term'] as const)
        if (patch[k] !== undefined && typeof patch[k] !== 'string') return fail('bad_request', `${k} 需为字符串`);
      if (patch.status !== undefined && patch.status !== 'pending' && patch.status !== 'published') return fail('bad_request', 'status 仅 pending|published');
      if (patch.sort !== undefined && (typeof patch.sort !== 'number' || !Number.isFinite(patch.sort))) return fail('bad_request', 'sort 需为数字');
      if (patch.url !== undefined) {
        const raw = (patch.url as string).trim();
        if (raw === '') return fail('bad_request', 'url 不能为空');
        const norm = normalizeUrl(raw);
        if (!norm) return fail('bad_request', 'url 非法（需 http/https，主机须含点）');
        // 裁定(a)：导出取 url_raw||url —— 只改 url 不带 url_raw 会让导出停在旧值，
        // 服务端兜底把 url_raw 同步为本次编辑的原始输入（UI 正常会显式同送两者）。
        if (patch.url_raw === undefined) patch.url_raw = raw;
        patch.url = norm; // url 列语义 = 规范化去重键，服务端统一规范化
      }
      // 集成点 3：patch 触碰 taxonomy/term 时对 existing+patch 合并后的 final pair 做形态归一再落库。
      // 例：嵌套旧 term 被 patch 进 flat 目标分类 → term 置空，不写入混用形态；嵌套分类清空 term → '未分组'。
      if (patch.taxonomy !== undefined || patch.term !== undefined) {
        const existing = await getSiteById(db, id);
        if (!existing) return jsonError('bad_request', '站点不存在', 404);
        const finalTax = patch.taxonomy !== undefined ? (patch.taxonomy as string) : existing.taxonomy;
        const finalTerm = patch.term !== undefined ? (patch.term as string) : existing.term;
        const resolved = await resolveCategoryShape(db, finalTax, finalTerm);
        patch.taxonomy = resolved.taxonomy;
        patch.term = resolved.term;
      }
      let row: SiteRow | null;
      try {
        row = await updateSite(db, id, patch as SitePatch);
      } catch (e) {
        // UNIQUE 检测与 pipeline.ts:123 同口径（belt-and-braces）：D1 冲突信息可能在 e.message 或 e.cause，两处都试
        const en = e as Error & { cause?: unknown };
        if (/UNIQUE/i.test(`${String(en?.cause ?? en)} ${String(en?.message ?? '')}`)) return fail('dup_url', '该 URL 已存在'); // 改 url 撞已有行
        throw e;
      }
      if (!row) return jsonError('bad_request', '站点不存在', 404);
      return json({ site: row });
    }
    if (req.method === 'DELETE') {
      await deleteSite(db, id); // 幂等：不存在也 204
      await pruneOrphanCategories(db); // 孤儿清理：站点消失后失去支撑的非空 term categories 行删除（term='' header 豁免，承载 icon/排序）
      return new Response(null, { status: 204 });
    }
    return fail('bad_request', '方法不支持');
  }

  // ── friendlinks（spec-27 §3.1）：仅非空校验，url 原样存（人工维护的字节保真数据） ──
  if (p === '/api/admin/friendlinks' && req.method === 'GET') return json({ friendlinks: await allFriendlinks(db) });
  if (p === '/api/admin/friendlinks' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const s = (k: string) => (typeof body?.[k] === 'string' ? (body[k] as string).trim() : undefined);
    if (!body || !s('title') || !s('url')) return fail('bad_request', '需要 {title,url} 均非空字符串');
    const sort = typeof body.sort === 'number' && Number.isFinite(body.sort) ? Math.trunc(body.sort) : 0;
    const row = await insertFriendlink(db, { title: s('title')!, url: s('url')!, description: s('description') ?? '', sort });
    return json({ friendlink: row }, 201);
  }
  if (p === '/api/admin/friendlinks/batch-delete' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const ids = body?.ids;
    if (!Array.isArray(ids) || !ids.length || !ids.every((n) => Number.isInteger(n) && (n as number) > 0)) return fail('bad_request', 'ids 需为正的整数数组');
    return json({ deleted: await deleteByIds(db, 'friendlinks', ids as number[]) });
  }
  const flM = /^\/api\/admin\/friendlinks\/(\d+)$/.exec(p);
  if (flM) {
    const id = Number(flM[1]);
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      if (!body) return fail('bad_request', '需要 JSON 对象');
      const patch: Record<string, unknown> = {};
      for (const k of ['title', 'url', 'description', 'sort'] as const) if (body[k] !== undefined) patch[k] = body[k];
      if (!Object.keys(patch).length) return fail('bad_request', '无可更新字段（白名单：title,url,description,sort）');
      for (const k of ['title', 'url', 'description'] as const) if (patch[k] !== undefined && (typeof patch[k] !== 'string' || (k !== 'description' && !(patch[k] as string).trim()))) return fail('bad_request', `${k} 需为非空字符串`);
      if (patch.sort !== undefined && (typeof patch.sort !== 'number' || !Number.isFinite(patch.sort))) return fail('bad_request', 'sort 需为数字');
      const row = await updateFriendlink(db, id, patch as never);
      return row ? json({ friendlink: row }) : jsonError('bad_request', '友链不存在', 404);
    }
    if (req.method === 'DELETE') { await deleteByIds(db, 'friendlinks', [id]); return new Response(null, { status: 204 }); }
    return fail('bad_request', '方法不支持'); // Task 4 评审结转：兜底对齐 sites 段——GET/PUT 不再漏到路由尾部 404
  }

  // ── navitems（spec-27 §3.2）：一层下拉限制（assertMount 闸）+ 原子批删 ──
  // 一层限制闸：parent 必须存在且为顶层；禁改挂向自身
  const assertMount = async (parent_id: number | null | undefined, selfId?: number): Promise<string | null> => {
    if (parent_id === null || parent_id === undefined) return null;
    if (selfId !== undefined && parent_id === selfId) return 'parent_id 不能指向自身';
    const parent = await getNavitemById(db, parent_id);
    if (!parent) return 'parent_id 指向不存在的项';
    if (parent.parent_id !== null) return '仅支持一层下拉：父项本身不能是子项';
    if (selfId !== undefined && (await countNavChildren(db, parent_id)) > 0 && parent.parent_id === null) {
      // 把「有子项的顶层」降为子项会造出三层结构——PATCH 时拒（POST 新项无子，天然不触发）
      if (selfId !== undefined) return '该顶层项已有子项，不能作为子项挂载（会超过一层）';
    }
    return null;
  };

  // GET 序（控制器裁定，db.ts 不改）：allNavitems 的 SQL 以顶层 id 群聚，此处路由层后处理为
  // 顶层按 (sort,id)、子项紧跟其父并按 (sort,id)；孤儿子项（父行不存在）保留在尾部同 key。
  if (p === '/api/admin/navitems' && req.method === 'GET') {
    const rows = await allNavitems(db);
    const tops: NavitemRow[] = [];
    const childrenOf = new Map<number, NavitemRow[]>();
    for (const r of rows) {
      if (r.parent_id === null) { tops.push(r); continue; }
      const arr = childrenOf.get(r.parent_id) ?? [];
      arr.push(r);
      childrenOf.set(r.parent_id, arr);
    }
    const order = (a: NavitemRow, b: NavitemRow): number => a.sort - b.sort || a.id - b.id;
    tops.sort(order);
    const out: NavitemRow[] = [];
    for (const t of tops) {
      out.push(t);
      out.push(...(childrenOf.get(t.id) ?? []).sort(order));
      childrenOf.delete(t.id);
    }
    out.push(...[...childrenOf.values()].flat().sort(order)); // 孤儿兜底：不静默丢行
    return json({ navitems: out });
  }
  if (p === '/api/admin/navitems' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body) return fail('bad_request', '需要 JSON 对象');
    const item = typeof body.item === 'string' ? body.item.trim() : '';
    if (!item) return fail('bad_request', '需要 {item:string 非空, icon?, link?, parent_id?, sort?}');
    if (body.parent_id !== undefined && body.parent_id !== null && !(Number.isInteger(body.parent_id) && (body.parent_id as number) > 0)) {
      return fail('bad_request', 'parent_id 需为 null 或正整数');
    }
    const pid = body.parent_id as number | null | undefined;
    const mountErr = await assertMount(pid); // POST 无 selfId：新项天然无子，只查挂载合法性
    if (mountErr) return fail('bad_request', mountErr);
    const str = (k: string): string => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
    const sort = typeof body.sort === 'number' && Number.isFinite(body.sort) ? Math.trunc(body.sort) : 0;
    const row = await insertNavitem(db, { item, icon: str('icon'), link: str('link'), parent_id: pid ?? null, sort });
    return json({ navitem: row }, 201);
  }
  // 字面量段先于 /:id 正则（同 friendlinks）：POST batch-delete 不被当成 id。原子性=先全量校验后删除。
  if (p === '/api/admin/navitems/batch-delete' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const ids = body?.ids;
    if (!Array.isArray(ids) || !ids.length || !ids.every((n) => Number.isInteger(n) && (n as number) > 0)) return fail('bad_request', 'ids 需为正的整数数组');
    const uniq = [...new Set(ids as number[])];
    const idSet = new Set(uniq);
    const rows = await allNavitems(db);
    const byId = new Map<number, NavitemRow>(rows.map((r) => [r.id, r]));
    const kidsOf = new Map<number, number[]>();
    for (const r of rows) {
      if (r.parent_id === null) continue;
      const arr = kidsOf.get(r.parent_id) ?? [];
      arr.push(r.id);
      kidsOf.set(r.parent_id, arr);
    }
    for (const id of uniq) {
      const row = byId.get(id);
      if (!row || row.parent_id !== null) continue; // 不存在的 id 幂等跳过；子项无「未选中的子」可言
      const missing = (kidsOf.get(id) ?? []).filter((k) => !idSet.has(k));
      if (missing.length) return fail('bad_request', `顶层项「${row.item}」仍有未选中的子项（id ${missing.join(', ')}）：批量删除需连同子项一并勾选（整体拒绝，零删除）`);
    }
    return json({ deleted: await deleteByIds(db, 'navitems', uniq) });
  }
  const nvM = /^\/api\/admin\/navitems\/(\d+)$/.exec(p);
  if (nvM) {
    const id = Number(nvM[1]);
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      if (!body) return fail('bad_request', '需要 JSON 对象');
      const patch: Record<string, unknown> = {};
      for (const k of ['item', 'icon', 'link', 'parent_id', 'sort'] as const) if (body[k] !== undefined) patch[k] = body[k];
      if (!Object.keys(patch).length) return fail('bad_request', '无可更新字段（白名单：item,icon,link,parent_id,sort）');
      if (patch.item !== undefined && (typeof patch.item !== 'string' || !(patch.item as string).trim())) return fail('bad_request', 'item 需为非空字符串');
      for (const k of ['icon', 'link'] as const) if (patch[k] !== undefined && typeof patch[k] !== 'string') return fail('bad_request', `${k} 需为字符串`); // link/icon 允许空串（纯下拉容器）
      if (patch.sort !== undefined && (typeof patch.sort !== 'number' || !Number.isFinite(patch.sort))) return fail('bad_request', 'sort 需为数字');
      if (patch.parent_id !== undefined && patch.parent_id !== null && !(Number.isInteger(patch.parent_id) && (patch.parent_id as number) > 0)) {
        return fail('bad_request', 'parent_id 需为 null 或正整数');
      }
      const existing = await getNavitemById(db, id);
      if (!existing) return jsonError('bad_request', '导航项不存在', 404);
      if (patch.parent_id === null && (await countNavChildren(db, id)) > 0) return fail('bad_request', '请删除子项后再升顶');
      const mountErr = await assertMount(patch.parent_id as number | null | undefined, id);
      if (mountErr) return fail('bad_request', mountErr);
      // verbatim 闸只查目标父的子项数（注释原文「把『有子项的顶层』降为子项」指自身）：
      // 自身有子降挂到无子顶层仍会造三层，此处在 handler 侧补自身维度检查，不变式封死。
      if (patch.parent_id !== undefined && patch.parent_id !== null && (await countNavChildren(db, id)) > 0) {
        return fail('bad_request', '该项已有子项，不能作为子项挂载（会超过一层）');
      }
      if (patch.item !== undefined) patch.item = (patch.item as string).trim();
      if (patch.icon !== undefined) patch.icon = (patch.icon as string).trim();
      if (patch.link !== undefined) patch.link = (patch.link as string).trim();
      if (patch.sort !== undefined) patch.sort = Math.trunc(patch.sort as number);
      const row = await updateNavitem(db, id, patch as never);
      return row ? json({ navitem: row }) : jsonError('bad_request', '导航项不存在', 404);
    }
    if (req.method === 'DELETE') {
      const existing = await getNavitemById(db, id);
      const kids = existing ? await countNavChildren(db, id) : 0;
      if (existing && kids > 0) {
        return fail('bad_request', `该顶层项下仍有 ${kids} 个子项：请先删除子项，或用 batch-delete 连同子项一并勾选`);
      }
      await deleteByIds(db, 'navitems', [id]); // 幂等：不存在也 204（同 friendlinks 口径）
      return new Response(null, { status: 204 });
    }
    return fail('bad_request', '方法不支持');
  }

  // ── categories ──
  if (p === '/api/admin/categories') {
    if (req.method === 'GET') {
      // shapes：union（categories∪sites）形态视图，供后台分类/子分类选择器联动；
      // 数据源与 resolveCategoryShape 一致（同 taxonomy 同 nested 判定），原 categories 字段不动（向后兼容）。
      const pairs = await categoryShapePairs(db);
      const termsOf = new Map<string, string[]>();
      for (const x of pairs) {
        const arr = termsOf.get(x.taxonomy) ?? [];
        termsOf.set(x.taxonomy, arr);
        if (x.term !== '' && !arr.includes(x.term)) arr.push(x.term);
      }
      const shapes = [...termsOf.entries()]
        .map(([taxonomy, terms]) => ({ taxonomy, nested: terms.length > 0, terms: [...terms].sort() }))
        .sort((a, b) => a.taxonomy.localeCompare(b.taxonomy));
      return json({ categories: await allCategories(db), shapes });
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || typeof body.taxonomy !== 'string' || body.taxonomy.trim() === '') return fail('bad_request', '需要 {taxonomy:string,...}');
      const tax = body.taxonomy.trim();
      const termIn = typeof body.term === 'string' ? body.term.trim() : '';
      // 集成点 4：显式管理端点用拒绝而非静默改写（更诚实）。已有相反形态行 → 400；未知分类放行。
      // flat 且补空 term（=既有形态）放行；嵌套/mixed 加非空子分类放行（新子分类自动新增=用户裁决）。
      const shape = shapeOfTaxonomy(await categoryShapePairs(db), tax);
      if ((termIn === '' && (shape === 'nested' || shape === 'mixed')) || (termIn !== '' && shape === 'flat')) {
        return fail('bad_request', `分类「${tax}」既有形态为 ${shape}，与本次 {term:${termIn === '' ? "''" : termIn}} 相反；请先修正既有行，不提供半混用形态`);
      }
      const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
      const sort = typeof body.sort === 'number' && Number.isFinite(body.sort) ? Math.trunc(body.sort) : undefined;
      await upsertCategory(db, { taxonomy: tax, term: str(body.term), icon: str(body.icon), sort });
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
          // title 一并入参（终局评审 Important #4）：parser 已产出 bm.title，此前被丢弃致降级行标题退化为 host。
          // 仅 title 不带 taxonomy 不触发直通跳过（src/pipeline.ts:93，跳过需 title+taxonomy 同非空），
          // 仍走抓取+AI，仅按 hint 语义字段覆盖。明确不做：folder→taxonomy、addDate→created_at（已 parked）。
          const r = await analyzeAndUpsert({ url: bm.url, title: bm.title, source: 'import' }, env, db);
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
        await pruneOrphanCategories(db); // 回滚终点：orig 原样回插，孤儿集合不因这次失败变化，照 prune 顺带清历史非空 term 孤儿（term='' 豁免）
        return fail(r.code, '重新分析失败');
      }
      // 重分析不改发布状态与排序（人工确认语义由 PATCH/publish 承担）；
      // url_raw 必须一并回写保留（终局评审 Important #3）：analyzeAndUpsert({url: orig.url}) 会把
      // 新行 url_raw 烤成规范化键（seed-dup 行含 #seed-dup-N 尾巴），而展示与导出走 url_raw（src/yml.ts
      // 的 q(r.url_raw || r.url)）——不回写原值等于把 dedup 尾巴发布上线。
      const kept: SiteRow = (await updateSite(db, r.row.id, { status: orig.status, sort: orig.sort, url_raw: orig.url_raw })) ?? r.row;
      await pruneOrphanCategories(db); // 成功终点：原 pair 若失去全部站点行，其 categories 孤儿一并清除
      return json({ site: kept });
    } catch (e) {
      // analyzeAndUpsert/回写阶段抛异常：原行已删，必须先回滚再报 502（code 枚举无 internal，取 fetch_failed 承载内部失败）
      await restore();
      await pruneOrphanCategories(db); // restore 回滚路径同样 prune（brief 点名；原行回插后孤儿判定基准已恢复）
      console.error('reanalyze threw:', id, e);
      return fail('fetch_failed', '重新分析失败');
    }
  }
}
