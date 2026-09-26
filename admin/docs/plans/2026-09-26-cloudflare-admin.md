# noisedh-admin（Cloudflare 导航站后台）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现替代 yaml-server 的 Cloudflare Worker 后台：书签导入→D1→AI/降级解析→重建 webstack.yml 推 GitHub→触发 Pages 重建，并兼容 Nav-manage-extension 一键收藏。

**Architecture:** 单 Worker（`noisedh-admin`）+ 单 D1（`navdata`）+ Workers Assets 无构建管理页；区域路由挂 `nav.wzyo.top/admin*`、`/api/*`、`/data*`。D1 为唯一权威源，publish 时整文件重建 `data/webstack.yml` 经 GitHub Contents API 推送。

**Tech Stack:** TypeScript strict、Cloudflare Workers、D1、Vitest、miniflare（本地 D1 测试）、js-yaml（仅本地 seed 脚本）。运行时零第三方依赖（书签解析/序列化/规范化全手写）。

**Spec:** `admin/docs/specs/2026-09-26-cloudflare-admin-design.md`（先读 §3-§6；扩展契约见下方"附录 A"，已从 popup.js 实测逆推）

## Global Constraints

- 所有代码在 `admin/` 目录内，独立 `package.json`，不碰站点其余目录
- Worker 运行时不使用 npm 依赖（依赖只进 devDependencies/本地脚本）
- 鉴权统一 `Authorization: Bearer ${ADMIN_TOKEN}`，`crypto.timingSafeEqual` 比较；未授权一律 401 `{error:"unauthorized"}`
- 错误响应统一 `{error:code,message}`，code 枚举：`unauthorized/bad_request/dup_url/fetch_failed/ai_invalid/github_conflict/too_large`
- URL 规范化后为 `sites.url` 唯一键；`url_raw` 原样保留
- 一切外部 fetch 带超时与单次重试；AI 输出不合规整条降级、不半采信
- `friendlinks.yml`、`headers.yml` 不纳入 D1 权威流：读透传、写返回 501
- 提交信息中文，一次任务一提交
- 验收不变式（贯穿）：seed 导入 D1 → 导出 yml → 与 `data/webstack.yml` 深比较相等

## 文件结构

```
admin/
  package.json tsconfig.json wrangler.jsonc schema.sql
  src/
    types.ts       SiteRow/CategoryRow/Env 类型（Task 1）
    errors.ts      jsonError/codes（Task 1）
    auth.ts        requireAuth（Task 1）
    url.ts         normalizeUrl（Task 2）
    yml.ts         buildWebstackYml + 站点行→yml 文本（Task 3）
    extract.ts     extractBaseline(html) + fetchPage（Task 4）
    ai.ts          aiAnalyze（Task 5）
    db.ts          D1 查询/写入助手（Task 6）
    pipeline.ts    analyzeAndUpsert（Task 6）
    bookmarks.ts   parseChromeBookmarks（Task 7）
    routes.ts      /api/admin/* 处理器（Task 7/8）
    github.ts      getContent/putContent（注入 fetchImpl）（Task 8）
    publish.ts     doPublish（Task 8）
    extension.ts   附录 A 六个兼容接口（Task 10）
    notifications.ts （Task 10）
    index.ts       路由表入口（Task 1 骨架，后续扩展）
  public/
    index.html admin.js                 （Task 11）
  scripts/
    seed.mjs       data/webstack.yml → seed.sql（本地 node，Task 9）
  test/
    *.test.ts  + fixtures/（webstack.sample.yml、bookmarks.chrome.html、ai/*.json、github/*.json）
```

---

### Task 1: 项目脚手架 + errors/auth

**Files:**
- Create: `admin/package.json`, `admin/tsconfig.json`, `admin/wrangler.jsonc`, `admin/schema.sql`, `admin/src/types.ts`, `admin/src/errors.ts`, `admin/src/auth.ts`, `admin/src/index.ts`, `admin/test/auth.test.ts`

**Interfaces:**
- Produces: `Env`、`SiteRow`、`CategoryRow`（types.ts）；`jsonError(code:string,message:string,status:number):Response`；`requireAuth(req:Request,env:Env):boolean`；schema.sql 两张表（spec §3 原文）

- [ ] **Step 1: 脚手架文件。** `package.json`：devDeps `typescript@^5`, `vitest@^2`, `miniflare@^3`, `@cloudflare/workers-types`, `wrangler@^4`；scripts：`test`= `vitest run`、`typecheck`= `tsc --noEmit`、`dev`= `wrangler dev`、`seed`= `node scripts/seed.mjs`。`tsconfig.json`：strict、`types:[" @cloudflare/workers-types"]`、moduleResolution bundler。`wrangler.jsonc`：name noisedh-admin、main src/index.ts、`assets={bucket:"public"}`、d1_bindings `DB`→navdata、compatibility_date 取今日。`schema.sql` 用 spec §3 的两段 DDL。
- [ ] **Step 2: 写失败测试** `test/auth.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { requireAuth } from '../src/auth';
const mk = (tok?: string) => new Request('https://x/api/admin/sites', tok ? { headers: { Authorization: `Bearer ${tok}` } } : {});
describe('requireAuth', () => {
  const env = { ADMIN_TOKEN: 's3cret-long-random' } as any;
  it('正确 token 通过', () => expect(requireAuth(mk('s3cret-long-random'), env)).toBe(true));
  it('缺失/错误 token 拒绝', () => {
    expect(requireAuth(mk(), env)).toBe(false);
    expect(requireAuth(mk('wrong'), env)).toBe(false);
    expect(requireAuth(mk('s3cret-long-rando'), env)).toBe(false); // 长度差 1
  });
});
```

- [ ] **Step 3: 运行确认失败** `cd admin && npx vitest run test/auth.test.ts` → Cannot find module
- [ ] **Step 4: 实现** `auth.ts`：

```ts
export function requireAuth(req: Request, env: { ADMIN_TOKEN: string }): boolean {
  const got = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const want = env.ADMIN_TOKEN;
  if (!want || got.length !== want.length) return false;
  const enc = new TextEncoder();
  return crypto.timingSafeEqual(enc.encode(got), enc.encode(want));
}
```

`errors.ts`：

```ts
export const CODES = ['unauthorized','bad_request','dup_url','fetch_failed','ai_invalid','github_conflict','too_large'] as const;
export type ErrCode = (typeof CODES)[number];
export function jsonError(code: ErrCode, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: code, message }), { status, headers: { 'Content-Type': 'application/json' } });
}
```

`types.ts`：SiteRow（spec §3 列序与类型逐字段一致）+ `CategoryRow{taxonomy:string;term:string;icon:string;sort:number}` + `Env{ADMIN_TOKEN:string;GITHUB_TOKEN:string;AI_BASE_URL?:string;AI_API_KEY?:string;AI_MODEL?:string;DEFAULT_TAXONOMY:string;FAVICON_TEMPLATE:string;REPO:string;DB:D1Database}`。
`index.ts`：`export default { async fetch(req, env): Promise<Response> { const u = new URL(req.url); if (u.pathname.startsWith('/api/admin/')) { if (!requireAuth(req, env)) return jsonError('unauthorized','需要管理令牌',401); } return new Response('ok'); } }`（路由表后续任务填充）。
- [ ] **Step 5: 运行通过** `npx vitest run && npx tsc --noEmit` → PASS
- [ ] **Step 6: 提交** `git add admin && git commit -m "noisedh-admin 脚手架：类型、错误壳、Bearer 鉴权"`

---

### Task 2: URL 规范化

**Files:**
- Create: `admin/src/url.ts`, `admin/test/url.test.ts`

**Interfaces:**
- Produces: `normalizeUrl(raw: string): string | null`（null=不可解析；输出小写 host、去尾斜杠、剥跟踪参数、保 hash 其余参数）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '../src/url';
describe('normalizeUrl', () => {
  it('补协议、小写 host、去尾斜杠', () => {
    expect(normalizeUrl('WWW.Example.COM/Path/')).toBe('https://www.example.com/Path');
    expect(normalizeUrl('example.com')).toBe('https://example.com');
  });
  it('剥跟踪参数保留业务参数', () => {
    expect(normalizeUrl('https://a.cn/p?utm_source=x&id=7#g')).toBe('https://a.cn/p?id=7#g');
    expect(normalizeUrl('https://a.cn/p?spm=1.2&gclid=y&from=z&ref=w&a=1')).toBe('https://a.cn/p?a=1');
  });
  it('非法输入返回 null', () => { expect(normalizeUrl('not a url')).toBeNull(); expect(normalizeUrl('')).toBeNull(); });
  it('端口与查询保序', () => {
    expect(normalizeUrl('http://a.cn:8080/x?b=2&a=1')).toBe('http://a.cn:8080/x?b=2&a=1');
  });
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** `url.ts`：

```ts
const TRACKING = /^(utm_|gclid$|spm$|from$|ref$|fbclid$|ssc.?id$)/i;
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : 'https://' + raw.trim()); }
  catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
  u.hostname = u.hostname.toLowerCase();
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k));
  u.search = ''; for (const [k, v] of keep) u.searchParams.append(k, v);
  let s = u.toString();
  if (s.endsWith('/') && u.pathname === '/') s = s.slice(0, -1);
  return s;
}
```

- [ ] **Step 4: 运行通过**（若 `example.com` 用例因 search 序列化差异失败，以测试断言为准微调实现的斜杠处理，不得反向改测试语义）
- [ ] **Step 5: 提交** `git commit -am "URL 规范化：跟踪参数剥离与唯一键形态"`

---

### Task 3: yml 序列化器 + round-trip 不变式

**Files:**
- Create: `admin/src/yml.ts`, `admin/test/yml.test.ts`, `admin/test/fixtures/webstack.sample.yml`（从仓库 `data/webstack.yml` 拷贝前 ~120 行，须同时含直挂 `links` 形态分类与 `list[{term,links}]` 嵌套形态各至少一个）

**Interfaces:**
- Produces: `buildWebstackYml(sites: SiteRow[], categories: CategoryRow[]): string`（两种输出形态与现有文件一致；term 全空→直挂 links；文本以 `---\n` 开头；字符串值仅在含 `: `、`#`、前导特殊字符或首尾空格时加双引号转义；键序 taxonomy/icon/(list|links)/term 与现有文件一致）

- [ ] **Step 1: 从 fixture 手写"期望行"数组作为测试数据**（不 import js-yaml 进 Worker 测试——测试里允许 `js-yaml` devDep 解析比对）。`test/yml.test.ts`：

```ts
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { describe, it, expect } from 'vitest';
import { buildWebstackYml } from '../src/yml';
import type { SiteRow, CategoryRow } from '../src/types';
const FIX = 'test/fixtures/webstack.sample.yml';
const row = (o: Partial<SiteRow>): SiteRow => ({ id: 0, url: o.url!, url_raw: o.url_raw ?? o.url!, title: o.title!, description: '', logo: '', taxonomy: o.taxonomy!, term: o.term ?? '', status: 'published', source: 'seed', sort: o.sort ?? 0, created_at: '', updated_at: '' });
describe('buildWebstackYml 不变式', () => {
  it('fixture 导入→导出语义相等', () => {
    const orig = yaml.load(readFileSync(FIX, 'utf8')) as any[];
    // 展平 fixture 成行（直挂与嵌套两种形态都处理）
    const rows: SiteRow[] = []; const cats: CategoryRow[] = [];
    orig.forEach((t, ti) => {
      cats.push({ taxonomy: t.taxonomy, term: '', icon: t.icon, sort: ti });
      const groups = t.links ? [{ term: '', links: t.links }] : t.list;
      groups.forEach((g: any, gi: number) => {
        if (g.term) cats.push({ taxonomy: t.taxonomy, term: g.term, icon: '', sort: gi });
        g.links.forEach((l: any, li: number) =>
          rows.push(row({ url: l.url, title: l.title, description: l.description, logo: l.logo, taxonomy: t.taxonomy, term: g.term || '', sort: li })));
      });
    });
    const rebuilt = yaml.load(buildWebstackYml(rows, cats)) as any[];
    expect(rebuilt).toEqual(orig);
  });
  it('冒号/井号标题被正确转义', () => {
    const out = buildWebstackYml([row({ url: 'https://a', title: 'B: C #1', taxonomy: 'T' })], [{ taxonomy: 'T', term: '', icon: 'i', sort: 0 }]);
    expect((yaml.load(out) as any[])[0].links[0].title).toBe('B: C #1');
  });
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** `yml.ts`：分组（taxonomy→term，各按 categories.sort、行按 sort/id 排），逐行拼接：

```ts
const q = (s: string) => (/[:#\[\]{}&*!|>'%@`]/.test(s) || /^\s|\s$/.test(s) || s === '' ? JSON.stringify(s) : s);
// 直挂形态: `- taxonomy: X\n  icon: I\n  links:\n    - title: T\n      logo: L\n      url: U\n      description: D`
// 嵌套形态: `- taxonomy: X\n  icon: I\n  list:\n    - term: Y\n      links:\n        - title: ...`（缩进 +4）
export function buildWebstackYml(sites: SiteRow[], categories: CategoryRow[]): string { /* 按上述骨架实现，published 行才输出 */ }
```

（字段输出顺序 title/logo/url/description，与现有文件一致；`logo`/`description` 为空时省略该键——fixture 里每条都有这两键，实现须以"存在才输出、seed 行必有值"验证通过）
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: 提交** `git commit -am "webstack.yml 序列化器：双形态 round-trip 不变式"`

---

### Task 4: 页面抓取与基线提取

**Files:**
- Create: `admin/src/extract.ts`, `admin/test/extract.test.ts`

**Interfaces:**
- Produces: `extractBaseline(html: string): { title: string; description: string }`（纯函数）；`fetchPage(url: string, fetchImpl?: typeof fetch): Promise<{ html: string } | { error: string }>`（15s AbortController、浏览器 UA、跟随重定向、body 截 64KB；失败 `{error:'fetch_failed'}`，单次重试）

- [ ] **Step 1: 写失败测试**（fetchPage 用注入的假 fetch 测超时外的核心行为：截断、错误映射）

```ts
import { describe, it, expect } from 'vitest';
import { extractBaseline } from '../src/extract';
const html = `<html><head><title>CG99-CG设计网 - CG99</title>
<meta name="description" content="专注全球CG设计行业"><meta property="og:site_name" content="CG99"></head><body/></html>`;
describe('extractBaseline', () => {
  it('裁站点后缀取主标题', () => expect(extractBaseline(html).title).toBe('CG99-CG设计网'));
  it('取 meta description', () => expect(extractBaseline(html).description).toBe('专注全球CG设计行业'));
  it('无 meta 用 og:description，再无则空', () => {
    expect(extractBaseline('<title>x</title><meta property="og:description" content="og文">').description).toBe('og文');
    expect(extractBaseline('<title>x</title>').description).toBe('');
  });
  it('title 缺失退到 og:site_name 再退空串', () => {
    expect(extractBaseline('<meta property="og:site_name" content="Site">').title).toBe('Site');
  });
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**：正则提取 `<title[^>]*>([\s\S]*?)</title>`（含属性顺序变体）、`meta name|property=... content=...`（content 支持双/单引号与属性序颠倒）；后缀裁剪：按 `/\s*[|｜–—-]\s*/` split，若首段长度 ≥4 取首段，否则整串。`fetchPage` 按接口约定实现，`TextDecoder('utf-8')` 解码前 65536 字节。
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: 提交** `git commit -am "页面基线提取：标题/meta 解析与带超时抓取"`

---

### Task 5: AI 分析模块（严格校验）

**Files:**
- Create: `admin/src/ai.ts`, `admin/test/ai.test.ts`, `admin/test/fixtures/ai/ok.json`, `admin/test/fixtures/ai/bad-json.json`, `admin/test/fixtures/ai/unknown-taxonomy.json`

**Interfaces:**
- Consumes: `Env.AI_BASE_URL/AI_API_KEY/AI_MODEL`
- Produces: `type AiResult = { title: string; description: string; taxonomy: string; term: string; newCategory: boolean }`；`aiAnalyze(input: { url: string; pageText: string; baselineTitle: string; categories: string[] }, env, fetchImpl?: typeof fetch): Promise<AiResult | null>`（null=未配置或任何不合规，调用方走降级）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { aiAnalyze, type AiResult } from '../src/ai';
const env = { AI_BASE_URL: 'https://x/v1', AI_API_KEY: 'k', AI_MODEL: 'm' } as any;
const fakeFetch = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
const input = { url: 'https://cg99.com', pageText: 'CG 设计资源站', baselineTitle: 'CG99', categories: ['媒体创作'] };
describe('aiAnalyze', () => {
  it('合法 JSON 解析为结果', async () => {
    const r = await aiAnalyze(input, env, fakeFetch({ choices: [{ message: { content: JSON.stringify({ title: 'CG99', description: 'CG设计资源', taxonomy: '媒体创作', term: '素材', new_category: false }) } }] }));
    expect(r).toEqual({ title: 'CG99', description: 'CG设计资源', taxonomy: '媒体创作', term: '素材', newCategory: false } satisfies AiResult);
  });
  it('非 JSON / 字段缺失 / 未知分类且非 new_category → null', async () => {
    expect(await aiAnalyze(input, env, fakeFetch({ choices: [{ message: { content: '抱歉，' } }] }))).toBeNull();
    expect(await aiAnalyze(input, env, fakeFetch({ choices: [{ message: { content: '{"title":"t"}' } }] }))).toBeNull();
    expect(await aiAnalyze(input, env, fakeFetch({ choices: [{ message: { content: '{"title":"t","description":"d","taxonomy":"外星分类","term":"","new_category":false}' } }] }))).toBeNull();
  });
  it('未配置 AI → null 且不发请求', async () => {
    let called = false;
    expect(await aiAnalyze(input, {} as any, (async () => { called = true; return new Response('{}'); }) as any)).toBeNull();
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**：POST `${AI_BASE_URL}/chat/completions`，body `{model, temperature:0, response_format:{type:'json_object'}, messages:[{role:'system',content:SYSTEM},{role:'user',content:user(input)}]}`；SYSTEM 内容（写死中文）：要求"仅输出 JSON，字段 title(≤30字,去站点后缀)、description(≤40字,中文,概括网站做什么)、taxonomy、term(可为空串)、new_category(布尔)；分类必须优先从给定列表中选择 {categories}"。校验：JSON.parse 失败→null；缺任一字段/类型错→null；taxonomy 不在 categories 且 new_category!==true→null。网络/AI 异常 catch→null。单次重试。
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: 提交** `git commit -am "AI 分析：OpenAI 兼容调用与全有或全无输出校验"`

---

### Task 6: D1 助手 + 解析流水线

**Files:**
- Create: `admin/src/db.ts`, `admin/src/pipeline.ts`, `admin/test/pipeline.test.ts`

**Interfaces:**
- Consumes: `normalizeUrl`、`extractBaseline/fetchPage`、`aiAnalyze`、types
- Produces: `db.ts`: `getSiteByUrl(db,url)`, `insertSite(db, row: Omit<SiteRow,'id'|'created_at'|'updated_at'>)`, `updateSite(db,id,patch)`, `deleteSite(db,id)`, `listSites(db,{status?,taxonomy?,q?,page?,perPage?})`, `allPublishedRows(db)`, `allCategories(db)`, `upsertCategory(db,{taxonomy,term,icon?,sort?})`；`pipeline.ts`: `analyzeAndUpsert(opts:{url,title?,description?,taxonomy?,term?,logo?,source}, env, db, deps?:{fetchImpl, now}): Promise<{ ok: true; row: SiteRow; deduped: boolean } | { ok: false; code: ErrCode }>`

- [ ] **Step 1: 写失败测试**（miniflare 本地 D1；`vitest` 文件顶部）：

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFileSync } from 'node:fs';
import { analyzeAndUpsert } from '../src/pipeline';
const mf = new Miniflare({ log: new Log(LogLevel.ERROR), modules: true, script: 'export default{}', d1Databases: ['DB'], d1Persist: false });
beforeAll(async () => { const db: any = mf.getD1Database('DB'); await db.exec(readFileSync('schema.sql', 'utf8')); });
const fakeHtml = (t: string) => (async (u: any) => new Response(`<title>${t}</title><meta name="description" content="desc-${t}">`, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
describe('analyzeAndUpsert（无 AI 降级路径）', () => {
  it('入库 pending + 默认分类 + favicon 模板 logo', async () => {
    const env: any = { DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: 'https://icons.test/ip3/{host}.ico' };
    const r = await analyzeAndUpsert({ url: 'https://NewSite.cn/x', source: 'manual' }, env, mf.getD1Database('DB') as any, { fetchImpl: fakeHtml('新站') });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.row).toMatchObject({ url: 'https://newsite.cn/x', title: '新站', taxonomy: '未分类', status: 'pending', logo: 'https://icons.test/ip3/newsite.cn.ico' }); }
  });
  it('重复 URL 返回 dup_url 且不新增', async () => {
    const r = await analyzeAndUpsert({ url: 'https://newsite.cn/x/', source: 'manual' }, { DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: 'x{host}y' } as any, mf.getD1Database('DB') as any, { fetchImpl: fakeHtml('x') });
    expect(r).toEqual({ ok: false, code: 'dup_url' });
  });
  it('显式字段优先于抓取（扩展直通）', async () => {
    const r = await analyzeAndUpsert({ url: 'https://b.cn', title: '给定题', taxonomy: 'T1', term: 'S1', source: 'extension' }, {} as any, mf.getD1Database('DB') as any, { fetchImpl: fakeHtml('页内题') });
    if (!r.ok) throw new Error('should pass');
    expect(r.row).toMatchObject({ title: '给定题', taxonomy: 'T1', term: 'S1' });
  });
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** `pipeline.ts` 编排（spec §4 顺序）：normalizeUrl→null 则 `bad_request`；getSiteByUrl 命中→`dup_url`；**显式字段合并策略**：调用方给了 title+taxonomy 则跳过 AI 与抓取（扩展直通），否则 fetchPage→extractBaseline→（env 有 AI 配置则 aiAnalyze，pageText 用剥标签后的正文前 4KB）→不合规用基线+DEFAULT_TAXONOMY；logo 空则 FAVICON_TEMPLATE 替换 `{host}`；upsertCategory（新分类时）；insertSite(status pending)。`deps.fetchImpl` 默认 globalThis.fetch。`db.ts` 全部单语句 + `updated_at=datetime('now')`。
- [ ] **Step 4: 运行通过**
- [ ] **Step 5: 提交** `git commit -am "解析流水线：抓取→AI→降级→D1 入库与去重"`

---

### Task 7: 书签解析 + /api/admin 核心路由

**Files:**
- Create: `admin/src/bookmarks.ts`, `admin/src/routes.ts`, `admin/test/bookmarks.test.ts`, `admin/test/routes.test.ts`, `admin/test/fixtures/bookmarks.chrome.html`（手写 Netscape 格式样本：两顶层文件夹"书签栏/其他书签"、嵌套子文件夹、10 条 A 标签、1 条重复 URL、1 条非法 URL、含 ADD_DATE/LAST_MODIFIED 属性）
- Modify: `admin/src/index.ts`（挂路由表）

**Interfaces:**
- Consumes: `analyzeAndUpsert`、`requireAuth`、`jsonError`
- Produces: `parseChromeBookmarks(html: string): { title: string; url: string; folder: string; addDate?: number }[]`（folder=首层之后的路径，`书签栏/其他书签` 前缀丢弃）；`handleAdmin(req: Request, url: URL, env: Env): Promise<Response | null>` 覆盖 spec §6 表中 `/api/admin/sites*`、`/api/admin/import`、`/api/admin/categories*` 的 CRUD（publish 在 Task 8 补进同一函数）；批量导入并发 3

- [ ] **Step 1: 写失败测试**（解析器）

```ts
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseChromeBookmarks } from '../src/bookmarks';
const items = parseChromeBookmarks(readFileSync('test/fixtures/bookmarks.chrome.html', 'utf8'));
describe('parseChromeBookmarks', () => {
  it('展平全部 A 标签并跳过账户根文件夹', () => expect(items.length).toBe(11)); // fixture 内全部 A 标签数
  it('folder 为账户层以下路径', () => expect(items.find(i => i.url.includes('cg99'))?.folder).toBe('设计/素材'));
  it('保留 ADD_DATE', () => expect(typeof items[0].addDate).toBe('number'));
});
```

- [ ] **Step 2: 运行确认失败 → 实现**：状态机按行扫描 `<DL>`/`</DL>`/`<H3[^>]*>(.*?)</H3>`/`<A HREF="([^"]+)"[^>]*>([\s\S]*?)</A>`（大小写不敏感，ADD_DATE 用属性正则提取），维护文件夹栈。- [ ] **Step 3: routes 测试**（miniflare 起 `wrangler dev` 太重，用 `unstable_dev` 是正解）：`test/routes.test.ts` 用 `import { unstable_dev } from 'wrangler'` 起本地实例（vars: ADMIN_TOKEN='t'，sqlite 本地 D1），断言：无 token→401；`POST /api/admin/sites {url:'javascript:alert(1)'}`→400 bad_request；`POST /api/admin/import {html:<fixture>}` 在 fetchImpl 不可注入环境下只断言计数结构 `{added:9, skipped_dup:1, failed:1}` 与 items 形状（导入的内部页抓取在 unstable_dev 里允许真实失败走降级：title 退化 host）。- [ ] **Step 4: 实现 handleAdmin + index.ts 分发**（GET 列表分页 `?status=&q=&taxonomy=&page=`，PATCH 白名单字段 title,description,logo,taxonomy,term,status,sort，DELETE 204，import 大小 >10MB → too_large）。- [ ] **Step 5: 全绿** `npx vitest run && npx tsc --noEmit`。- [ ] **Step 6: 提交** `git commit -am "Chrome 书签解析与后台 CRUD/导入路由"`

---

### Task 8: GitHub 模块 + publish

**Files:**
- Create: `admin/src/github.ts`, `admin/src/publish.ts`, `admin/test/publish.test.ts`；Modify: `admin/src/routes.ts`

**Interfaces:**
- Consumes: `buildWebstackYml`、`allPublishedRows/allCategories`
- Produces: `ghGet(repo: string, path: string, token: string, fetchImpl): Promise<{ text: string; sha: string }>`；`ghPut(repo, path, text, sha, message, token, fetchImpl): Promise<{ commitUrl: string }>`；`doPublish(env, db, fetchImpl?): Promise<{ ok: true; commitUrl: string; count: number } | { ok: false; code: ErrCode; message: string }>`

- [ ] **Step 1: 写失败测试**：假 fetch 脚本化响应序列（GET contents→sha；PUT→200 html_url；冲突用例：PUT→409 `{message:"update-ref failed"}` 后重新 GET 内容含**非本次发布差异**→断言 `{ok:false,code:'github_conflict'}` 且不再 PUT）。断言 PUT body：`content` 为 UTF-8→base64（含中文"频道页面"往返）、`sha` 透传、路径 `repos/sjmw/noisedh-nav/contents/data/webstack.yml`。
- [ ] **Step 2: 确认失败 → 实现**：`ghGet` 带 `Accept: application/vnd.github.raw+json`? 否——需要 sha，用默认 JSON 解码 `content`（`atob` 会 latin1 坏中文，用 `Uint8Array.from(atob(c), ch=>ch.charCodeAt(0))` + `TextDecoder('utf-8')`）。`ghPut` body `{message, content: b64(utf8Bytes(text)), branch:'main', sha}`；409→重 GET：若远端 text 等于本次将写内容→视为成功，否则 `github_conflict` 停止（spec §5.4）。`doPublish` 读行→`buildWebstackYml`→PUT→成功后把 pending→published 状态回写由调用时机决定（发布即快照：所有 pending 行随本次 publish 置 published）。
- [ ] **Step 3: 路由**：`POST /api/admin/publish` → doPublish → `{commitUrl,count}` 或映射 jsonError。
- [ ] **Step 4: 全绿 → 提交** `git commit -am "GitHub Contents 读写与发布流程（UTF-8 正确 + sha 冲突中止）"`

---

### Task 9: seed 脚本与灌库

**Files:**
- Create: `admin/scripts/seed.mjs`, `admin/test/seed.test.mjs`, `admin/seed.sql`（生成物，入库提交）

**Interfaces:**
- Consumes: 仓库根 `data/webstack.yml`（js-yaml 解析，Node 本地）
- Produces: `seed.sql`（DELETE 后全量 INSERT，source='seed'，status='published'，categories 同步生成）；本地验证命令 `npm run seed`

- [ ] **Step 1: 写失败测试**（Node 环境 vitest）：跑 seed 生成器得 SQL 文本→在 miniflare D1 执行→用 Task 3 的 `buildWebstackYml` 导出→与真实 `data/webstack.yml` 做 `yaml.load` 深比较 `toEqual`。**这是全局不变式的最终闸口，用真实 1555 行文件。**
- [ ] **Step 2: 实现 seed.mjs**：读 yml→展平（直挂 term=''；嵌套取 g.term；icon 取分类级，term 级 icon 无则默认）→每条 INSERT 用参数化 JSON 转义（`sqlQuote = s => "'" + s.replace(/'/g, "''") + "'"`）。sort 按原序。
- [ ] **Step 3: 测试通过 → 提交** `git commit -am "seed 脚本：webstack.yml 全量导入 D1，round-trip 零漂移验证"`
- [ ] **Step 4:（部署任务后）远程灌库**：`wrangler d1 execute navdata --remote --file=./seed.sql`

---

### Task 10: 扩展兼容层 + notifications

**Files:**
- Create: `admin/src/extension.ts`, `admin/src/notifications.ts`, `admin/test/extension.test.ts`；Modify: `admin/src/index.ts`

**Interfaces:**
- Consumes: `analyzeAndUpsert`、`listSites`、`buildWebstackYml`、ghGet
- Produces（附录 A 契约）: `GET /data`→`["webstack.yml","friendlinks.yml","headers.yml"]`；`GET /data/{filename}`→webstack 由 D1 导出文本，其余 ghGet 透传（只读缓存 5min）；`POST /api/yaml`→ 仅 webstack.yml：`analyzeAndUpsert({…newDataEntry 直通字段, source:'extension'})`→204，其余文件名 501；`GET /api/search?keyword=&filePath=`→`[{kind,title,url,description,taxonomy,term}]`（LIKE 三字段）；`DELETE /api/delete {filename,title,kind}`→webstack 删行 204，其余 501；`POST /api/server-settings`→存 D1 `settings(key,value)` 表（schema.sql 追加）后 204；`GET /api/notifications`→最近 20 条 published：`[{title,description,url,timestamp}]`（timestamp=ISO updated_at）

- [ ] **Step 1: 写失败测试**：unstable_dev 起服务，逐接口按 popup.js 原样请求断言（含 Bearer、501 语义、search 结果字段名与 renderSearchResults 消费一致）。notifications 公开无鉴权断言 200。
- [ ] **Step 2: 实现 → 全绿 → 提交** `git commit -am "扩展兼容层（/data、/api/yaml、search、delete、settings）与 notifications"`

---

### Task 11: 管理 UI

**Files:**
- Create: `admin/public/index.html`, `admin/public/admin.js`

**Interfaces:** Consumes: `/api/admin/*`（fetch + localStorage token）

- [ ] **Step 1: 实现**：单页三视图（spec §7）：口令条（sessionStorage）、导入（`<input type=file>`+FileReader→POST import）、列表（表格+行内编辑 PATCH+批量发布）、新增（URL→POST sites）。原生 JS 无依赖，全部操作有 toast 反馈；publish 按钮显示返回 commitUrl 链接。
- [ ] **Step 2: `wrangler dev` 本地打开逐视图手工冒烟**（点击路径写进提交信息体）
- [ ] **Step 3: 提交** `git commit -am "内置管理单页：导入/列表编辑/新增/发布"`

---

### Task 12: 部署与端到端冒烟（需用户口令与手机）

- [ ] **Step 1:** `wrangler d1 create navdata` → 回填 wrangler.jsonc database_id；`wrangler secret put ADMIN_TOKEN/GITHUB_TOKEN`（PAT 由用户创建：fine-grained，单仓 Contents:RW）；AI 三项按用户提供的服务商配置
- [ ] **Step 2:** `wrangler deploy`；`wrangler versions` 确认资产
- [ ] **Step 3:** 区域路由（API：`POST /zones/{wzyo.top zone id}/filters` + rules，或 dashboard 三条：`nav.wzyo.top/admin*`、`nav.wzyo.top/api/*`、`nav.wzyo.top/data*` → noisedh-admin）。**注意验证 Pages 域名对路由的优先级行为，若 `/api/*` 路由在 Pages 自定义域上不生效，回退方案：改 Pages 的 `_worker.js`?? 否——立即停下报告，不要私改前台**
- [ ] **Step 4:** 远程灌 seed（Task 9 Step 4）→ `POST /api/admin/publish` 干跑（应产生语义相同 diff 为零的 commit 或"无变更"短路）
- [ ] **Step 5: 用户冒烟**：真实书签导入→编辑→发布→Pages 构建→前台新条目可见→手机扩展改 serverUrl=`https://nav.wzyo.top` 点收藏→`/admin` 出现 pending→publish 上线
- [ ] **Step 6: 收尾提交**：部署手册写进 `admin/README.md`（含 PAT 权限说明、路由截图位、回滚步骤）；更新根目录交接文档第 10 节（yaml-server 退役、待办 2 销账）

---

## 附录 A：扩展契约实测记录（源自 popup.js 行号）

| 接口 | 方法/形状 | 证据 |
|---|---|---|
| 文件列表 | `GET /data` → `string[]` | popup.js:597,600 |
| 文件内容 | `GET /data/{encodeURIComponent(name)}` → yaml 文本 | popup.js:605-608 |
| 收藏写入 | `POST /api/yaml` Bearer；`{filename, newDataEntry:{title,url,logo,description,kind,taxonomy?,term?}, allowCreateCategory}` → 2xx | popup.js:1195-1200 |
| 搜索 | `GET /api/search?keyword=&filePath=` → `[{kind,title,url,description,taxonomy,term}]` | popup.js:1311,1260-1283 |
| 删除 | `DELETE /api/delete` Bearer；`{filename,title,kind}` → 2xx | popup.js:1344-1352 |
| 推送参数 | `POST /api/server-settings` Bearer；扁平字符串对象 | popup.js:207-210 |
| 鉴权头 | `Authorization: Bearer ${serverToken||token}` | popup.js:179-184 |

## Self-Review 记录

- 覆盖检查：spec §2→Task1/12，§3→Task1/3/6，§4→Task4/5/6/7，§5→Task8，§6→Task7/10，§7→Task11，§9→各任务测试步+Task9 闸口，§3.2/不变式→Task3+Task9 ✅
- 类型一致性：`analyzeAndUpsert` 返回判别联合在 Task 6 定义、Task 7/10 引用一致 ✅
- 已知妥协（执行时不得扩大）：Task 7 import 集成测试允许真实抓取失败走降级；notifications 的 updated_at 当 timestamp（无独立发布时间表）
