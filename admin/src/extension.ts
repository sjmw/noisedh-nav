// 扩展兼容层（spec §6.1，附录 A 契约）：按 Nav-manage-extension/popup.js 实测形状实现
// GET /data、GET /data/{file}、POST /api/yaml、GET /api/search、DELETE /api/delete、POST /api/server-settings。
// 鉴权矩阵：读面（/data*、/api/search）公开（popup.js:597/605/1311 均不发 Authorization 头）；
// 写面（/api/yaml、/api/delete、/api/server-settings）由 index.ts 统一 requireAuth（spec §6:125、§11「不新增任何匿名写接口」）。
// friendlinks.yml / headers.yml 不纳入 D1：读 = ghGet 透传（5min 只读缓存），写 = 501 拒绝（全局约束）。

import { analyzeAndUpsert } from './pipeline';
import { normalizeUrl } from './url';
import { buildWebstackYml } from './yml';
import { ghGet } from './github';
import { jsonError, errStatus, readJsonBody } from './errors';
import {
  getSiteByUrl, updateSite, deleteSite, findOldestSiteByTitle,
  allPublishedRows, allCategories, upsertCategory, listSites,
} from './db';
import type { SitePatch } from './db';
import type { Env } from './types';

const FILES = ['webstack.yml', 'friendlinks.yml', 'headers.yml'];
const READ_TTL_MS = 5 * 60 * 1000;

// 只读透传缓存：模块级 Map 是 per-isolate 的（Cloudflare 多 isolate 间不共享、冷启动即失），
// 语义为「每活跃 isolate 5 分钟内至多一次 GitHub 请求」，用于弹窗切文件/重复读取的抖动抑制，不追求全局一致。
const readCache = new Map<string, { text: string; at: number }>();

// popup.js:219-224 detectKind 同构：以「小写包含」判定文件域，兼容 'data/webstack.yml' 之类的历史路径值
const kindOf = (name: unknown): 'webstack' | 'friendlinks' | 'headers' => {
  const f = String(name ?? '').toLowerCase();
  if (f.includes('friendlinks')) return 'friendlinks';
  if (f.includes('headers')) return 'headers';
  return 'webstack';
};

// errStatus（错误码→HTTP 状态）与 readJsonBody 已收口至 errors.ts（终局评审 minor-5，纯搬移）

// 严格白名单（终局评审 minor-1）：kindOf 的「未知名默认落 webstack」是读面/搜索面的宽容兼容，
// 写面不可继承——文件名（小写）不含 webstack 一律按 friendlinks/headers 同款 501 信封拒绝。
// popup 只发三型文件名（webstack/friendlinks/headers.yml 及 data/webstack.yml 历史路径形），兼容不受影响。
const writableWebstack = (name: unknown): boolean => String(name ?? '').toLowerCase().includes('webstack');

// 与 handleAdmin 同一外壳约定：仅在「路径不属于本兼容层」时返回 null（index.ts 继续往下）
export async function handleExtension(
  req: Request,
  u: URL,
  env: Env,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<Response | null> {
  try {
    return await route(req, u, env, deps);
  } catch (e) {
    console.error('extension route unhandled error:', u.pathname, e);
    return jsonError('fetch_failed', '服务器内部错误', 500);
  }
}

async function route(req: Request, u: URL, env: Env, deps: { fetchImpl?: typeof fetch }): Promise<Response | null> {
  const p = u.pathname;
  const db = env.DB;

  // ── GET /data → string[]（popup.js:597,600）──
  if (p === '/data') {
    if (req.method !== 'GET') return jsonError('bad_request', '方法不支持', 400);
    return Response.json(FILES);
  }

  // ── GET /data/{encodeURIComponent(name)} → yaml 文本（popup.js:605-608，res.text() 消费）──
  if (p.startsWith('/data/')) {
    if (req.method !== 'GET') return jsonError('bad_request', '方法不支持', 400);
    let name = '';
    try {
      name = decodeURIComponent(p.slice('/data/'.length));
    } catch {
      return jsonError('bad_request', '文件名编码非法', 400);
    }
    const lower = name.toLowerCase();
    if (lower === 'webstack.yml') {
      const text = buildWebstackYml(await allPublishedRows(db), await allCategories(db));
      return new Response(text, { headers: { 'Content-Type': 'text/yaml; charset=utf-8' } });
    }
    if (lower === 'friendlinks.yml' || lower === 'headers.yml') {
      const cached = readCache.get(lower);
      if (cached && Date.now() - cached.at < READ_TTL_MS) {
        return new Response(cached.text, { headers: { 'Content-Type': 'text/yaml; charset=utf-8' } });
      }
      try {
        const { text } = await ghGet(env.REPO, `data/${lower}`, env.GITHUB_TOKEN, deps.fetchImpl ?? globalThis.fetch);
        readCache.set(lower, { text, at: Date.now() });
        return new Response(text, { headers: { 'Content-Type': 'text/yaml; charset=utf-8' } });
      } catch (e) {
        // GitHub 面任何失败（网络/4xx/5xx/解码）统一 502 fetch_failed 信封（spec §8 口径：上游失败；404 亦不外透，避免探测仓库文件存在性）
        console.error('ghGet passthrough failed:', lower, e);
        return jsonError('fetch_failed', `透传读取 ${lower} 失败`, 502);
      }
    }
    return jsonError('bad_request', `文件不存在：只读列表为 ${FILES.join(', ')}`, 404);
  }

  // ── POST /api/yaml（Bearer，index 层已鉴权）：仅 webstack 域可写 ──
  if (p === '/api/yaml') {
    if (req.method !== 'POST') return jsonError('bad_request', '方法不支持', 400);
    const body = await readJsonBody(req);
    if (!body || typeof body.filename !== 'string') return jsonError('bad_request', '需要 {filename,newDataEntry,...}', 400);
    const entry = body.newDataEntry;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return jsonError('bad_request', 'newDataEntry 需为对象', 400);
    const e = entry as Record<string, unknown>;
    const str = (k: string): string => (typeof e[k] === 'string' ? (e[k] as string).trim() : '');
    if (kindOf(body.filename) !== 'webstack') {
      return jsonError('bad_request', `${body.filename} 为只读透传文件（friendlinks.yml/headers.yml 不纳入 D1，不支持写入）`, 501);
    }
    if (!writableWebstack(body.filename)) {
      return jsonError('bad_request', `${body.filename} 不在可写白名单：文件名需含 webstack（friendlinks.yml/headers.yml 只读透传，其余文件域不存在）`, 501);
    }
    const url = str('url');
    if (url === '') return jsonError('bad_request', 'newDataEntry.url 必填', 400);
    const r = await analyzeAndUpsert(
      { url, title: str('title'), description: str('description'), logo: str('logo'), taxonomy: str('taxonomy'), term: str('term'), source: 'extension' },
      env, db,
    );
    if (r.ok) return new Response(null, { status: 204 });
    if (r.code === 'dup_url') return dupToUpdate(db, e); // ledger 裁定：重复收藏 = 直通更新显式非空字段 + 保留 status，绝不重跑抓取/AI
    return jsonError(r.code, r.code === 'bad_request' ? 'URL 非法' : '收藏入库失败', errStatus[r.code]);
  }

  // ── GET /api/search?keyword=&filePath=（公开，popup.js:1311）──
  if (p === '/api/search') {
    if (req.method !== 'GET') return jsonError('bad_request', '方法不支持', 400);
    const keyword = (u.searchParams.get('keyword') ?? '').trim();
    const filePath = u.searchParams.get('filePath') ?? '';
    if (kindOf(filePath) !== 'webstack' || keyword === '') return Response.json([]);
    // 三字段 LIKE（title/url/description）与 popup 本地搜索口径一致；含 pending：
    // 扩展是管理工具（Nav-manage-extension），手机收藏后进 pending 即需在此可见可删（Task 12 冒烟链路）。
    const { rows } = await listSites(db, { q: keyword, perPage: 200 });
    return Response.json(
      rows.map((s) => ({ kind: 'webstack', title: s.title, url: s.url_raw || s.url, description: s.description, taxonomy: s.taxonomy, term: s.term })),
    );
  }

  // ── DELETE /api/delete（Bearer，popup.js:1344-1352）──
  if (p === '/api/delete') {
    if (req.method !== 'DELETE') return jsonError('bad_request', '方法不支持', 400);
    const body = await readJsonBody(req);
    if (!body || typeof body.title !== 'string' || body.title === '') return jsonError('bad_request', '需要 {filename,title,kind}', 400);
    if (kindOf(body.filename) !== 'webstack') {
      return jsonError('bad_request', `${body.filename} 为只读透传文件（friendlinks.yml/headers.yml 不纳入 D1，不支持删除）`, 501);
    }
    if (!writableWebstack(body.filename)) {
      return jsonError('bad_request', `${body.filename} 不在可删白名单：文件名需含 webstack（friendlinks.yml/headers.yml 只读透传，其余文件域不存在）`, 501);
    }
    // 同名按最早 id 删除（追加序=文件展示序，删旧留新）；查无此题 → 204 幂等（popup 只判 res.ok）
    const row = await findOldestSiteByTitle(db, body.title);
    if (row) await deleteSite(db, row.id);
    return new Response(null, { status: 204 });
  }

  // ── POST /api/server-settings（Bearer，popup.js:207-210 扁平字符串对象）──
  if (p === '/api/server-settings') {
    if (req.method !== 'POST') return jsonError('bad_request', '方法不支持', 400);
    const body = await readJsonBody(req);
    if (!body) return jsonError('bad_request', '需要扁平 JSON 对象', 400);
    for (const [k, v] of Object.entries(body)) {
      if (typeof v !== 'string') return jsonError('bad_request', `settings 值需为字符串（键 ${k}）`, 400);
      // 原样存储、不解释语义（推送参数由前台/扩展自行消费）
      await db
        .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
        .bind(k, v)
        .run();
    }
    return new Response(null, { status: 204 });
  }

  return null;
}

// dup_url → 更新原行显式非空字段（title/description/logo/taxonomy/term），保留 status（不自动发布）、
// 保留 url/url_raw/id/source（updateSite 白名单按 patch 键，绝不解绑重插——id 不变即「未重跑抓取/AI」的落库证据）。
async function dupToUpdate(db: D1Database, e: Record<string, unknown>): Promise<Response> {
  const url = normalizeUrl(String(e.url ?? '').trim());
  if (!url) return jsonError('bad_request', 'URL 非法', 400);
  const existing = await getSiteByUrl(db, url);
  if (!existing) return new Response(null, { status: 204 }); // dup 判定后原行恰被并发删除：幂等成功
  const str = (k: string): string => (typeof e[k] === 'string' ? (e[k] as string).trim() : '');
  const patch: SitePatch = {};
  // 「非空才更新」按裁定字面执行：空串字段保留原值（含 term——清空需求走管理页 PATCH）
  for (const k of ['title', 'description', 'logo', 'taxonomy', 'term'] as const) {
    const v = str(k);
    if (v !== '') (patch as Record<string, string>)[k] = v;
  }
  if (Object.keys(patch).length > 0) {
    // 分类/子分类变化时补 categories 行（发布导出依赖 icon；upsertCategory 为 DO NOTHING 补位语义，无条件安全）
    await upsertCategory(db, { taxonomy: patch.taxonomy ?? existing.taxonomy, term: patch.term ?? existing.term });
    await updateSite(db, existing.id, patch); // 白名单字段、不含 status → 发布状态原样保留
  }
  return new Response(null, { status: 204 });
}
