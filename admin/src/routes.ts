// /api/admin/* 核心路由（spec §6，含 Task 8 接入的 POST /api/admin/publish）。
// 约定：handleAdmin 仅在「路径不属于 /api/admin/」时返回 null（index.ts 继续往下分发）；
// 属于 /api/admin/ 但未匹配到端点 → 404 jsonError。鉴权由 index.ts 在进入前统一 requireAuth。
// 响应壳：单行 {site}、列表 {sites,total,page,perPage}、分类 {categories}；错误一律 {error,message}。

import { parseChromeBookmarks } from './bookmarks';
import { normalizeUrl } from './url';
import { analyzeAndUpsert } from './pipeline';
import { doPublish } from './publish';
import { jsonError, errStatus, readJsonBody } from './errors';
import { categoryShapePairs, resolveCategoryShape, shapeOfTaxonomy } from './category';
import { FA_CLASS, resolveIcon } from './icons';
import {
  listSites, getSiteById, insertSite, updateSite, deleteSite,
  upsertCategory, deleteCategory, getCategory,
  allFriendlinks, insertFriendlink, updateFriendlink, deleteByIds,
  allNavitems, insertNavitem, updateNavitem, getNavitemById, countNavChildren,
  countSitesByPair, countSitesByTaxonomy, renameTaxonomy, renameTerm,
  deleteSitesByIds, deleteSitesByFilter,
} from './db';
import type { SitePatch } from './db';
import type { Env, SiteRow, CategoryRow, NavitemRow } from './types';
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

  // ── sites 批删三形态（Task 8）：置于 /:id 正则之前，避免 'batch-delete' 被当成 id ──
  // 互斥：{ids:[…]} xor {filter:{…}} xor {wipe:'全部删除'}；恰好其一，否则 400（防无参误删）。
  if (p === '/api/admin/sites/batch-delete' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body) return fail('bad_request', '需要 JSON 对象');
    const forms = [body.wipe !== undefined, Array.isArray(body.ids), body.filter !== undefined];
    if (forms.filter(Boolean).length !== 1) return fail('bad_request', '需三选一：{ids:[…]} | {filter:{…}} | {wipe:"全部删除"}');
    if (body.wipe !== undefined) {
      if (body.wipe !== '全部删除') return fail('bad_request', '清空全库需 {wipe:"全部删除"} 逐字确认');
      return json({ deleted: await deleteSitesByFilter(db, {}) }); // wipe 是唯一显式全表删路径（需逐字确认）
    }
    if (Array.isArray(body.ids)) {
      const ids = body.ids as unknown[];
      if (!ids.length || !ids.every((n) => Number.isInteger(n) && (n as number) > 0)) return fail('bad_request', 'ids 需为非空正整数数组');
      return json({ deleted: await deleteSitesByIds(db, ids as number[]) });
    }
    const f = body.filter as Record<string, unknown>;
    if (typeof f !== 'object' || f === null) return fail('bad_request', 'filter 需为对象');
    // 安全闸（T1 review）：filter 键白名单 + 至少一个非空条件——空 opts 会经 sitesWhere 清全表，唯 wipe 可全删。
    const FILTER_KEYS = ['q', 'status', 'taxonomy', 'term'] as const;
    for (const k of Object.keys(f)) if (!FILTER_KEYS.includes(k as (typeof FILTER_KEYS)[number])) return fail('bad_request', `filter 含白名单外的键：${k}`);
    const s = (k: (typeof FILTER_KEYS)[number]) => (typeof f[k] === 'string' && (f[k] as string) !== '' ? (f[k] as string) : undefined);
    const opts = { q: s('q'), status: s('status'), taxonomy: s('taxonomy'), term: s('term') };
    if (Object.values(opts).every((v) => v === undefined)) return fail('bad_request', 'filter 需至少一个非空条件（q/status/taxonomy/term）');
    return json({ deleted: await deleteSitesByFilter(db, opts) });
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
      // R4（spec-27）：不再 prune——失去站点支撑的 categories 行保留（一等公民），由分类管理页显式删除
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
  // 一层限制闸：parent 必须存在且为顶层；禁改挂向自身。
  // 审查裁决1：目标侧「该顶层项已有子项」计数分支删除——把子项挂到已有子的顶层是合法操作；
  // 一层不变式由「父须顶层」闸 + 下方 PATCH 自侧降挂闸封死（评审审计确认无逃逸路径）。
  const assertMount = async (parent_id: number | null | undefined, selfId?: number): Promise<string | null> => {
    if (parent_id === null || parent_id === undefined) return null;
    if (selfId !== undefined && parent_id === selfId) return 'parent_id 不能指向自身';
    const parent = await getNavitemById(db, parent_id);
    if (!parent) return 'parent_id 指向不存在的项';
    if (parent.parent_id !== null) return '仅支持一层下拉：父项本身不能是子项';
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
      // 升顶闸（裁决2 三形态，行为4b 固化）：parent_id:null 仅拦「行有子」——
      // ① 无子顶层 no-op → 放行 200；② 有子顶层 → 语义突变仍 400（UI 编辑有子顶层须省略 parent_id）；
      // ③ 真升顶（existing.parent_id !== null）：一层不变式下子行必无子 → 天然放行 200（脏态「有子之子」也会被本闸兜住）。
      if (patch.parent_id === null && (await countNavChildren(db, id)) > 0) return fail('bad_request', '请删除子项后再升顶');
      const mountErr = await assertMount(patch.parent_id as number | null | undefined, id);
      if (mountErr) return fail('bad_request', mountErr);
      // 降挂闸（自侧，裁决1 后一层不变式对降挂的唯一守卫）：该顶层项已有子项，不能作为子项挂载——
      // 把「有子项的顶层」降为子项会造出三层（POST 新项无子，天然不触发）。
      if (patch.parent_id !== undefined && patch.parent_id !== null && (await countNavChildren(db, id)) > 0) {
        return fail('bad_request', '该顶层项已有子项，不能作为子项挂载（会超过一层）');
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

  // ── categories（spec-27 §3.3 一等公民进化：siteCount / PATCH 改名级联 / 非空禁删 / 原子批删；R4 prune 退场）──
  if (p === '/api/admin/categories') {
    if (req.method === 'GET') {
      // siteCount：spec-27 §3.3——任意 status（与形态权威口径一致）；子查询按 pair 精确匹配。
      // 附加键不改既有行字段（向后兼容：前台/扩展只读 taxonomy/term/icon/sort）。
      const cats = await db.prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM sites s WHERE s.taxonomy = c.taxonomy AND s.term = c.term) AS siteCount
         FROM categories c ORDER BY c.taxonomy, c.term`,
      ).all<CategoryRow & { siteCount: number }>();
      // shapes：union（categories∪sites）形态视图，供后台分类/子分类选择器联动；
      // 数据源与 resolveCategoryShape 一致（同 taxonomy 同 nested 判定），原 shapes 字段计算不动。
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
      return json({ categories: cats.results, shapes });
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
      // icon（spec-27 §5.3）：显式送值必须过 FA_CLASS 闸（不再被补位语义静默忽略——非类名串会毒化前台模板）；
      // 缺省走 resolveIcon（AI 优先；vars 未配 AI_* 时零网络直落规则表——直通路径零网络纪律由 icons.ts 未配置快路径保证）。
      const iconIn = typeof body.icon === 'string' ? body.icon.trim() : '';
      let icon: string;
      if (iconIn !== '') {
        if (!FA_CLASS.test(iconIn)) return fail('bad_request', 'icon 需为 Font Awesome 类名（fas/far/fab fa-name）');
        icon = iconIn;
      } else {
        icon = await resolveIcon(`${tax} ${termIn}`.trim(), env);
      }
      const sort = typeof body.sort === 'number' && Number.isFinite(body.sort) ? Math.trunc(body.sort) : undefined;
      await upsertCategory(db, { taxonomy: tax, term: termIn, icon, sort }); // 补位语义不变：既有行不被覆盖
      return json({ category: await getCategory(db, tax, termIn) }, 201); // Task 7：204 → 201 {category}（UI 取回自动 icon）
    }
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const tax = typeof body?.taxonomy === 'string' ? body.taxonomy.trim() : '';
      const term = typeof body?.term === 'string' ? body.term.trim() : '';
      const nw = (body?.new ?? {}) as Record<string, unknown>;
      if (!tax) return fail('bad_request', '需要 {taxonomy,term,new:{taxonomy?,term?,icon?,sort?}}');
      const pairs = await categoryShapePairs(db);
      const exists = (t: string, m: string) => pairs.some((x) => x.taxonomy === t && x.term === m);
      if (!exists(tax, term)) return jsonError('bad_request', '分类行不存在', 404); // union 取证：站点侧形态也承认（改形不要求 categories 行先存在）
      const nTax = typeof nw.taxonomy === 'string' ? nw.taxonomy.trim() : tax;
      const nTerm = typeof nw.term === 'string' ? nw.term.trim() : term;
      if ('taxonomy' in nw && nTax === '') return fail('bad_request', 'new.taxonomy 不能为空（空分类名会毒化 shapes 与导出）');
      if (nTax === tax && nTerm === term) {
        // 只改 icon/sort：仅动 categories 定位行，不触碰 sites
        if (typeof nw.icon === 'string' && nw.icon.trim() !== '') {
          if (!FA_CLASS.test(nw.icon.trim())) return fail('bad_request', 'icon 需为 Font Awesome 类名（fas/far/fab fa-name）');
          await db.prepare('UPDATE categories SET icon = ? WHERE taxonomy = ? AND term = ?').bind(nw.icon.trim(), tax, term).run();
        }
        if (typeof nw.sort === 'number' && Number.isFinite(nw.sort))
          await db.prepare('UPDATE categories SET sort = ? WHERE taxonomy = ? AND term = ?').bind(Math.trunc(nw.sort), tax, term).run();
        return json({ category: await getCategory(db, tax, term) });
      }
      // 改名（taxonomy 或 term 或双双）：目标任一源已存在 → 拒（不隐式合并，spec-27 §1 非目标）。
      // 改 taxonomy 的闸按 spec §3.3「目标名在 categories∪sites 已存在」全名取证——renameTaxonomy 会把
      // 源分类全部行（header+子）迁入，目标名哪怕只有子行也构成隐式并仓/撞主键，必须拒。
      // 双双变更 = 整类改名 + 类内 term 改名（renameTerm 在迁移后的 nTax 下定位），非单行 reparent。
      const collision = nTax !== tax
        ? pairs.some((x) => x.taxonomy === nTax)
        : exists(nTax, nTerm);
      if (collision) return fail('bad_request', `目标「${nTax}${nTerm ? '/' + nTerm : ''}」已存在：不提供隐式合并，请先手动搬移站点`);
      // 两 helper 各含两条非事务 UPDATE（D1 batch 要求未执行语句，helper 已 bind+run 无法组入）——
      // 撞名闸已前置（spec §3.3「D1 无跨语句事务需求」条款），中途失败可安全重放同名操作。
      if (nTax !== tax) await renameTaxonomy(db, tax, nTax);
      if (nTerm !== term) await renameTerm(db, nTax, term, nTerm); // term 改名在 taxonomy 改名之后（定位已迁移的行）
      return json({ category: await getCategory(db, nTax, nTerm) });
    }
    if (req.method === 'DELETE') {
      const taxonomy = u.searchParams.get('taxonomy');
      if (!taxonomy) return fail('bad_request', '需要 ?taxonomy=&term=');
      const term = u.searchParams.get('term') ?? '';
      if (term === '') {
        // header/整类删：该 taxonomy 任意 term 有站点 → 400；零站点 → 连带删除其全部子分类行
        const n = await countSitesByTaxonomy(db, taxonomy);
        if (n > 0) return fail('bad_request', `分类「${taxonomy}」下仍有 ${n} 个站点：整类删除要求其全部 term 零站点，请先迁移或删除站点`);
        await db.prepare('DELETE FROM categories WHERE taxonomy = ?').bind(taxonomy).run();
      } else {
        const n = await countSitesByPair(db, taxonomy, term);
        if (n > 0) return fail('bad_request', `分类「${taxonomy}/${term}」下仍有 ${n} 个站点：非空分类不可删，请先迁移或删除站点`);
        await deleteCategory(db, taxonomy, term);
      }
      return new Response(null, { status: 204 });
    }
    return fail('bad_request', '方法不支持');
  }
  // 字面量段先于任何 :id 形态（Task 4/5 约定，categories 无 /:id 路由、位置同规）；原子性=先全量校验后删除。
  if (p === '/api/admin/categories/batch-delete') {
    if (req.method !== 'POST') return fail('bad_request', '方法不支持');
    const body = await readJsonBody(req);
    const inPairs = body?.pairs;
    if (!Array.isArray(inPairs) || !inPairs.length) return fail('bad_request', 'pairs 需为非空数组 [{taxonomy,term?}]');
    const targets: { taxonomy: string; term: string }[] = [];
    const seen = new Set<string>();
    for (const raw of inPairs) {
      const x = raw as Record<string, unknown> | null;
      const tax = x && typeof x.taxonomy === 'string' ? x.taxonomy.trim() : '';
      const term = x && typeof x.term === 'string' ? x.term.trim() : '';
      if (!tax) return fail('bad_request', 'pairs 每项需 {taxonomy:string 非空, term?:string}');
      const key = `${tax}\u0000${term}`;
      if (seen.has(key)) continue; // 重复 pair 折叠，deleted 计数不虚增
      seen.add(key);
      targets.push({ taxonomy: tax, term });
    }
    // 全量校验先行（header 用 countSitesByTaxonomy 整类口径，term 行用 countSitesByPair）：任一受阻 → 400 列全阻塞、零写
    const blocked: string[] = [];
    for (const t of targets) {
      const n = t.term === '' ? await countSitesByTaxonomy(db, t.taxonomy) : await countSitesByPair(db, t.taxonomy, t.term);
      if (n > 0) blocked.push(`「${t.taxonomy}${t.term ? '/' + t.term : ''}」仍有 ${n} 个站点`);
    }
    if (blocked.length) return fail('bad_request', `非空分类不可删：${blocked.join('；')}（整体拒绝，零删除）`);
    let deleted = 0;
    for (const t of targets) {
      // header（term=''）连带删除该 taxonomy 全部子行（与单删同规则）；changes 如实计数（缺行幂等记 0）
      const out = t.term === ''
        ? await db.prepare('DELETE FROM categories WHERE taxonomy = ?').bind(t.taxonomy).run()
        : await db.prepare('DELETE FROM categories WHERE taxonomy = ? AND term = ?').bind(t.taxonomy, t.term).run();
      deleted += (out.meta as { changes?: number }).changes ?? 0;
    }
    return json({ deleted });
  }

  // ── Task 8：POST /api/admin/publish（spec §5；鉴权已在 index 层完成）──
  if (p === '/api/admin/publish' && req.method === 'POST') {
    const r = await doPublish(env, db);
    if (!r.ok) return fail(r.code, r.message);
    return json({ commitUrl: r.commitUrl, count: r.count, friendlinks: r.friendlinks, navitems: r.navitems, files: r.files });
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
        // R4：回滚终点不再 prune（原行原样回插，历史空分类也留给分类管理页处置）
        return fail(r.code, '重新分析失败');
      }
      // 重分析不改发布状态与排序（人工确认语义由 PATCH/publish 承担）；
      // url_raw 必须一并回写保留（终局评审 Important #3）：analyzeAndUpsert({url: orig.url}) 会把
      // 新行 url_raw 烤成规范化键（seed-dup 行含 #seed-dup-N 尾巴），而展示与导出走 url_raw（src/yml.ts
      // 的 q(r.url_raw || r.url)）——不回写原值等于把 dedup 尾巴发布上线。
      const kept: SiteRow = (await updateSite(db, r.row.id, { status: orig.status, sort: orig.sort, url_raw: orig.url_raw })) ?? r.row;
      // R4：成功终点不再 prune——原 pair 若失去全部站点行，categories 行保留可见（siteCount=0），人工处置
      return json({ site: kept });
    } catch (e) {
      // analyzeAndUpsert/回写阶段抛异常：原行已删，必须先回滚再报 502（code 枚举无 internal，取 fetch_failed 承载内部失败）
      await restore(); // R4：回滚路径同样不再 prune
      console.error('reanalyze threw:', id, e);
      return fail('fetch_failed', '重新分析失败');
    }
  }
}
