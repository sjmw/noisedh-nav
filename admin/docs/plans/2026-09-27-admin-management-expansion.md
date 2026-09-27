# 后台管理扩展实施计划（友链 / 导航 / 分类管理 / 删除族 / 自动 icon）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec 把友情链接、顶部导航纳入 D1 真源与三文件发布，补齐删除族（勾选批删/筛选全删/清空全库 + 弹窗确认）、分类一等公民 CRUD（改名级联、非空禁删）与新分类 icon 自动决策链。

**Architecture:** 全部改动落在既有 Cloudflare Worker（`admin/src/`）+ D1 + 原生 JS 后台（`admin/public/admin.js`）。数据模型加 friendlinks / navitems 两张表；发布从单文件 webstack.yml 扩为三文件预检-后写；categories 从「流水线派生数据」升为「只增不自动删的一等实体」（prune 退场）。

**Tech Stack:** TypeScript（workerd，零运行时 npm 依赖）、D1（sqlite）、Vitest + Miniflare + unstable_dev、原生 DOM JS（admin.js，零 innerHTML）、js-yaml（仅 scripts/ 与测试 devDep）。

**Spec:** `admin/docs/specs/2026-09-27-admin-management-expansion-design.md`（裁决 R1–R4 在此，冲突以 spec 为准）

## Global Constraints

- 运行时零 npm 依赖：`src/` 不得 import 任何 npm 包（js-yaml 只许出现在 `scripts/` 与 `test/`）。
- 错误码冻结 7 项：`unauthorized, bad_request, dup_url, fetch_failed, ai_invalid, github_conflict, too_large`；守卫拒绝=bad_request(400)，缺行=bad_request(404)（沿用 `jsonError('bad_request','站点不存在',404)` 先例）。不新增枚举。
- admin.js 零 innerHTML：DOM 一律 `el(tag, cls, text)` / `document.createElement` 构建。
- 直通路径（POST 显式 title+taxonomy 齐）零网络不变：icon 只走规则表，不发 AI。
- seed.sql 每条语句严格单行（miniflare db.exec 按换行切分）；sites round-trip 逐字节闸口不许放松。
- 发布即快照：pending→published 翻转只在全部 PUT 成功之后；0 行闸与骤降闸仅针对 webstack。
- 远程副作用（remote D1 / deploy / publish / push / merge）一律用户放行，本计划全部任务在本地闭环。
- 每个任务收尾：`cd admin && npm test && npx tsc --noEmit` 全绿 + 单独 commit（中文单行，`feat:`/`test:`/`docs:` 前缀，风格随 git log）。
- 测试外部域名 TLD 用 `.test`；fake fetch 一律显式注入 `fetchImpl`。

---

### Task 1: 两张新表 + 类型 + db 助手（含 sitesWhere 提取）

**Files:**
- Modify: `admin/schema.sql`（追加两表一索引）
- Modify: `admin/src/types.ts`（追加两接口）
- Modify: `admin/src/db.ts`（追加 friendlink/navitem CRUD、批量删、pair 计数、改名级联；`listSites` 的 where 构造提取为 `sitesWhere`）
- Test: `admin/test/collections.db.test.ts`（新建）

**Interfaces:**
- Produces: `FriendlinkRow`、`NavitemRow`（types.ts）；`allFriendlinks / insertFriendlink / updateFriendlink / deleteFriendlink / deleteByIds(db,'friendlinks'|'navitems',ids)`、`allNavitems / insertNavitem / updateNavitem / deleteNavitem / countNavChildren / getNavitemById`、`sitesWhere(opts):{w,vals}`、`deleteSitesByFilter(db,opts):Promise<number>`、`deleteSitesByIds(db,ids):Promise<number>`、`countSitesByPair(db,taxonomy,term):Promise<number>`、`countSitesByTaxonomy(db,taxonomy):Promise<number>`、`renameTaxonomy(db,from,to)`、`renameTerm(db,taxonomy,from,to)`（均 db.ts）
- Consumes: 既有 `insertSite/updateSite` 的 RETURNING 惯式（照抄形态）。

- [ ] **Step 1: schema.sql 追加**（放在 categories 表之后、settings 之前，沿用注释风格）

```sql
-- 管理扩展轮（spec-27 §2）：友链与顶部导航以 D1 为真源；url/link 原样存，无状态列（改动随下一次发布上线）
CREATE TABLE IF NOT EXISTS friendlinks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS navitems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  parent_id INTEGER,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_navitems_parent ON navitems(parent_id);
```

- [ ] **Step 2: types.ts 追加**

```ts
export interface FriendlinkRow { id: number; title: string; url: string; description: string; sort: number; created_at: string; updated_at: string }
export interface NavitemRow { id: number; item: string; icon: string; link: string; parent_id: number | null; sort: number; created_at: string; updated_at: string }
```

- [ ] **Step 3: 写失败测试** `test/collections.db.test.ts`。建库方式照抄 `test/pipeline.test.ts` 头部（Miniflare + `readFileSync('schema.sql')` 压平 exec）。断言清单：

```ts
// friendlink：insert 返回含 id/时间戳完整行 → update 部分字段 → deleteByIds 返回 deleted 数 → allFriendlinks 按 (sort,id)
// navitem：顶层(parent_id null)与子项混插 → allNavitems 返回序 = 顶层按(sort,id)，子项紧跟其父（SQL 见 Step 5）
// countNavChildren(parentId)=子项数；updateNavitem 改 parent_id 生效
// sitesWhere：deleteSitesByFilter(db,{taxonomy:'筛选甲'}) 只删该分类且返回条数；{} = 全删；deleteSitesByIds 忽略不存在的 id 仍返回实删数
// countSitesByPair / countSitesByTaxonomy：pending+published 都计入（任意 status）
// renameTaxonomy：categories 的 header+子行与 sites 一并改名；renameTerm 同理且 sites.updated_at 刷新
```

示例（两条代表性用例，其余同型补全——不许只写 TODO）：

```ts
it('deleteSitesByFilter 空 opts=全库删，返回实删数', async () => {
  await insertSite(db, seedRow('https://wf1.test')); await insertSite(db, seedRow('https://wf2.test'));
  expect(await deleteSitesByFilter(db, {})).toBe(2);
  expect((await listSites(db)).total).toBe(0);
});
it('renameTaxonomy 级联 categories 全部行与 sites', async () => {
  await upsertCategory(db, { taxonomy: '旧名', term: '' });
  await upsertCategory(db, { taxonomy: '旧名', term: '子一' });
  await insertSite(db, { ...seedRow('https://rn.test'), taxonomy: '旧名', term: '子一' });
  await renameTaxonomy(db, '旧名', '新名');
  expect((await allCategories(db)).map((c) => c.taxonomy).sort()).toEqual(['新名', '新名']);
  expect((await getSiteByUrl(db, 'https://rn.test'))?.taxonomy).toBe('新名');
});
```

- [ ] **Step 4: 跑红** `npx vitest run test/collections.db.test.ts` → 引用不存在符号编译失败。

- [ ] **Step 5: 实现 db.ts 追加段**（置于文件尾部；insert/update 照 `insertSite/updateSite` 的 RETURNING 形态；批量删每批 90 个占位符，同 `markPendingPublished` 注释里的上限纪律）

```ts
// ── 管理扩展轮（spec-27）：friendlinks / navitems / 批量删 / 分类级联改名 ──
export async function allFriendlinks(db: D1Database): Promise<FriendlinkRow[]> {
  const { results } = await db.prepare('SELECT * FROM friendlinks ORDER BY sort, id').all<FriendlinkRow>();
  return results;
}
export async function insertFriendlink(db: D1Database, r: Omit<FriendlinkRow, 'id' | 'created_at' | 'updated_at'>): Promise<FriendlinkRow> {
  const row = await db.prepare('INSERT INTO friendlinks (title, url, description, sort) VALUES (?, ?, ?, ?) RETURNING *')
    .bind(r.title, r.url, r.description, r.sort).first<FriendlinkRow>();
  if (!row) throw new Error('insertFriendlink: RETURNING 行缺失');
  return row;
}
const FL_MUTABLE = ['title', 'url', 'description', 'sort'] as const;
export async function updateFriendlink(db: D1Database, id: number, patch: Partial<Pick<FriendlinkRow, (typeof FL_MUTABLE)[number]>>): Promise<FriendlinkRow | null> {
  const keys = FL_MUTABLE.filter((k) => patch[k] !== undefined);
  if (!keys.length) return getFriendlinkById(db, id);
  const sets = [...keys.map((k) => `${k} = ?`), `updated_at = datetime('now')`].join(', ');
  return (await db.prepare(`UPDATE friendlinks SET ${sets} WHERE id = ? RETURNING *`).bind(...keys.map((k) => patch[k] as never), id).first<FriendlinkRow>()) ?? null;
}
export async function getFriendlinkById(db: D1Database, id: number): Promise<FriendlinkRow | null> {
  return (await db.prepare('SELECT * FROM friendlinks WHERE id = ?').bind(id).first<FriendlinkRow>()) ?? null;
}
// 表名白名单内插值（非用户输入），ids 全为绑定参数
export async function deleteByIds(db: D1Database, table: 'friendlinks' | 'navitems', ids: number[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const out = await db.prepare(`DELETE FROM ${table} WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).run();
    n += (out.meta as { changes?: number }).changes ?? 0;
  }
  return n;
}
// navitems：顶层按 (sort,id)，子项紧跟其父（父缺失时孤儿子项也保留，排在尾部同 key）
export async function allNavitems(db: D1Database): Promise<NavitemRow[]> {
  const { results } = await db.prepare(
    `SELECT * FROM navitems ORDER BY COALESCE(parent_id, id), parent_id IS NOT NULL, sort, id`,
  ).all<NavitemRow>();
  return results;
}
export async function insertNavitem(db: D1Database, r: Omit<NavitemRow, 'id' | 'created_at' | 'updated_at'>): Promise<NavitemRow> {
  const row = await db.prepare('INSERT INTO navitems (item, icon, link, parent_id, sort) VALUES (?, ?, ?, ?, ?) RETURNING *')
    .bind(r.item, r.icon, r.link, r.parent_id, r.sort).first<NavitemRow>();
  if (!row) throw new Error('insertNavitem: RETURNING 行缺失');
  return row;
}
const NV_MUTABLE = ['item', 'icon', 'link', 'parent_id', 'sort'] as const;
export async function updateNavitem(db: D1Database, id: number, patch: Partial<Pick<NavitemRow, (typeof NV_MUTABLE)[number]>>): Promise<NavitemRow | null> {
  const keys = NV_MUTABLE.filter((k) => patch[k] !== undefined);
  if (!keys.length) return getNavitemById(db, id);
  const sets = [...keys.map((k) => `${k} = ?`), `updated_at = datetime('now')`].join(', ');
  return (await db.prepare(`UPDATE navitems SET ${sets} WHERE id = ? RETURNING *`).bind(...keys.map((k) => patch[k] as never), id).first<NavitemRow>()) ?? null;
}
export async function getNavitemById(db: D1Database, id: number): Promise<NavitemRow | null> {
  return (await db.prepare('SELECT * FROM navitems WHERE id = ?').bind(id).first<NavitemRow>()) ?? null;
}
export async function countNavChildren(db: D1Database, id: number): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM navitems WHERE parent_id = ?').bind(id).first<{ n: number }>())?.n ?? 0;
}
// sites 批量删：where 构造与 listSites 同源（提取为 sitesWhere，两处复用防漂移）
export function sitesWhere(opts: ListOpts): { w: string; vals: (string | number)[] } {
  const where: string[] = []; const vals: (string | number)[] = [];
  if (opts.status) { where.push('status = ?'); vals.push(opts.status); }
  if (opts.taxonomy) { where.push('taxonomy = ?'); vals.push(opts.taxonomy); }
  if (opts.term) { where.push('term = ?'); vals.push(opts.term); }
  if (opts.q) {
    const like = `%${opts.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    where.push(`(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`);
    vals.push(like, like, like);
  }
  return { w: where.length ? ` WHERE ${where.join(' AND ')}` : '', vals };
}
export async function deleteSitesByFilter(db: D1Database, opts: ListOpts): Promise<number> {
  const { w, vals } = sitesWhere(opts);
  const out = await db.prepare(`DELETE FROM sites${w}`).bind(...vals).run();
  return (out.meta as { changes?: number }).changes ?? 0;
}
export async function deleteSitesByIds(db: D1Database, ids: number[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const out = await db.prepare(`DELETE FROM sites WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).run();
    n += (out.meta as { changes?: number }).changes ?? 0;
  }
  return n;
}
export async function countSitesByPair(db: D1Database, taxonomy: string, term: string): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM sites WHERE taxonomy = ? AND term = ?').bind(taxonomy, term).first<{ n: number }>())?.n ?? 0;
}
export async function countSitesByTaxonomy(db: D1Database, taxonomy: string): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM sites WHERE taxonomy = ?').bind(taxonomy).first<{ n: number }>())?.n ?? 0;
}
export async function renameTaxonomy(db: D1Database, from: string, to: string): Promise<void> {
  await db.prepare('UPDATE categories SET taxonomy = ? WHERE taxonomy = ?').bind(to, from).run();
  await db.prepare(`UPDATE sites SET taxonomy = ?, updated_at = datetime('now') WHERE taxonomy = ?`).bind(to, from).run();
}
export async function renameTerm(db: D1Database, taxonomy: string, from: string, to: string): Promise<void> {
  await db.prepare('UPDATE categories SET term = ? WHERE taxonomy = ? AND term = ?').bind(to, taxonomy, from).run();
  await db.prepare(`UPDATE sites SET term = ?, updated_at = datetime('now') WHERE taxonomy = ? AND term = ?`).bind(to, taxonomy, from).run();
}
```

同时把 `listSites` 内联的 where 构造替换为 `const { w, vals } = sitesWhere(opts);`（行为逐字不变，既有 listSites 测试不许改动即是验证）。

- [ ] **Step 6: 跑绿 + 全量 + tsc + commit** `feat: 管理扩展 Task1——friendlinks/navitems 表与 db 助手，sitesWhere 提取复用`

---

### Task 2: 两份新 yml builder（yml.ts）

**Files:**
- Modify: `admin/src/yml.ts`（尾部追加两个导出，复用模块内私有 `q()`）
- Test: `admin/test/yml.test.ts`（追加 describe；若无此文件则新建，建法照现有 yml 测试——`grep -l buildWebstackYml test/` 找现家）

**Interfaces:**
- Consumes: `FriendlinkRow / NavitemRow`（Task 1）；`q`（yml.ts 既有）
- Produces: `buildFriendlinksYml(rows: FriendlinkRow[]): string`、`buildNavYml(rows: NavitemRow[]): string`（Task 3/9 消费）

- [ ] **Step 1: 写失败测试**（空表、序、条件字段、下拉分组、`link:""` 显式、相对链接原样）：

```ts
const fl = (id: number, over: Partial<FriendlinkRow> = {}): FriendlinkRow =>
  ({ id, title: `友链${id}`, url: `https://f${id}.test`, description: '', sort: 0, created_at: '', updated_at: '', ...over });
it('friendlinks：按 sort,id 出 - title/url/description；空表出 []', () => {
  expect(buildFriendlinksYml([])).toBe('[]\n');
  expect(buildFriendlinksYml([fl(2, { sort: 1 }), fl(1, { sort: 1, description: '带描述' })]))
    .toBe('- title: 友链1\n  url: https://f1.test\n  description: 带描述\n- title: 友链2\n  url: https://f2.test\n');
});
const nv = (id: number, over: Partial<NavitemRow> = {}): NavitemRow =>
  ({ id, item: `项${id}`, icon: '', link: `./x${id}/`, parent_id: null, sort: 0, created_at: '', updated_at: '', ...over });
it('navitems：顶层 item/icon/link，子项挂进父的 list[name,url]；link 空串显式输出', () => {
  expect(buildNavYml([nv(1), nv(2, { icon: 'fa fa-home' }), nv(21, { parent_id: 2, item: '😀Emoji', link: './assets/emoji/' })]))
    .toBe('- item: 项1\n  link: ./x1/\n- item: 项2\n  icon: fa fa-home\n  link: ./x2/\n  list:\n    - name: 😀Emoji\n      url: ./assets/emoji/\n');
  expect(buildNavYml([])).toBe('[]\n');
});
it('q() 语义继承：含 ": " 的 title 加引号', () => {
  expect(buildFriendlinksYml([fl(1, { title: 'a: b' })])).toBe('- title: "a: b"\n  url: https://f1.test\n');
});
```

- [ ] **Step 2: 跑红**（导入不存在）。
- [ ] **Step 3: 实现**（yml.ts 尾部）：

```ts
// 管理扩展轮（spec-27 §4）：friendlinks.yml / headers.yml 与 webstack 同纪律——确定性生成、同输入同字节。
import type { FriendlinkRow, NavitemRow } from './types';
export function buildFriendlinksYml(rows: FriendlinkRow[]): string {
  const sorted = [...rows].sort((a, b) => a.sort - b.sort || a.id - b.id);
  if (!sorted.length) return '[]\n';
  const lines: string[] = [];
  for (const r of sorted) {
    lines.push(`- title: ${q(r.title)}`, `  url: ${q(r.url)}`);
    if (r.description) lines.push(`  description: ${q(r.description)}`);
  }
  return lines.join('\n') + '\n';
}
export function buildNavYml(rows: NavitemRow[]): string {
  const tops = rows.filter((r) => r.parent_id === null).sort((a, b) => a.sort - b.sort || a.id - b.id);
  if (!tops.length) return '[]\n';
  const kids = new Map<number, NavitemRow[]>();
  for (const r of rows) if (r.parent_id !== null) (kids.get(r.parent_id) ?? kids.set(r.parent_id, []).get(r.parent_id)!).push(r);
  const lines: string[] = [];
  for (const t of tops) {
    lines.push(`- item: ${q(t.item)}`);
    if (t.icon) lines.push(`  icon: ${q(t.icon)}`);
    lines.push(`  link: ${q(t.link)}`); // 空串显式输出（「更多」纯下拉容器的现状形状）
    const kidList = (kids.get(t.id) ?? []).sort((a, b) => a.sort - b.sort || a.id - b.id);
    if (kidList.length) {
      lines.push('  list:');
      for (const k of kidList) lines.push(`    - name: ${q(k.item)}`, `      url: ${q(k.link)}`);
    }
  }
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: 跑绿 + 全量 + tsc + commit** `feat: 管理扩展 Task2——buildFriendlinksYml/buildNavYml（确定性导出，空表出 []）`

---

### Task 3: seed.mjs 三表化 + 语义 round-trip 闸口

**Files:**
- Modify: `admin/scripts/seed.mjs`
- Modify: `admin/seed.sql`（再生成）
- Test: `admin/test/seed.test.mjs`（追加断言段）

**Interfaces:**
- Consumes: `data/friendlinks.yml`、`data/headers.yml`（真实文件）；Task 2 builders
- Produces: `generateSeedSql(webstackText, friendlinksText, headersText): string`（签名变更，主程序与测试同步）

- [ ] **Step 1: 写失败测试**（seed.test.mjs 追加；webstack 逐字节断言原样保留）：

```ts
import * as yaml from 'js-yaml';
it('friendlinks/headers 语义 round-trip：seed 行经 builder 重建 ≡ 源文件（js-yaml 解析 deep-equal，含序）', () => {
  const fl = yaml.load(readFileSync(`${ROOT}../data/friendlinks.yml`, 'utf8')) as FriendlinkRow[];
  // seed.sql 解析出 friendlinks 插入行（按行正则 / /\(([^)]*)\)/ 反引 sqlQuote）或直接在生成函数里返回行集
  expect(yaml.load(buildFriendlinksYml(flRows))).toEqual(fl);
  expect(yaml.load(buildNavYml(navRows))).toEqual(yaml.load(headersText));
});
```

行集来源不靠解析 SQL：把 `generateSeedSql` 拆为 `flattenCollections(friendlinksText, headersText) → { flinks: Omit<FriendlinkRow,'id'|'created_at'|'updated_at'>[], navs: … }`（navitems 子项 parent 经文件序分配显式 id：顶层 id=1..n，子项接号），测试与 SQL 共用行集。

- [ ] **Step 2: 跑红**。
- [ ] **Step 3: 实现 seed.mjs**：`generateSeedSql` 改 3 参（后两参默认 `''`=不生成，保底兼容旧测试调用则直接改所有调用点，取后者）；首行 DELETE 扩为 `DELETE FROM sites; DELETE FROM categories; DELETE FROM friendlinks; DELETE FROM navitems;`；追加：

```js
if (flinks.length)
  lines.push(`INSERT INTO friendlinks (id, title, url, description, sort) VALUES ${flinks.map((r, i) => `(${i + 1}, ${sqlQuote(r.title)}, ${sqlQuote(r.url)}, ${sqlQuote(r.description)}, ${i})`).join(', ')};`);
// navitems：顶层 id 1..n，子项从 n+1 起；两语句（先父后子）保证外键语义（无 FK 约束，仅顺序习惯）
```

主程序读三文件、写 seed.sql、行数日志含三表。

- [ ] **Step 4: `npm run seed` 再生成 + 跑绿**。seed.sql 里 friendlinks 8 行、navitems 行数=顶层+子项（现文件 8 顶 + 8 子）；`npx wrangler d1 execute navdata --local --file=./seed.sql --yes` 本地重灌（cwd=admin），`GET /api/admin/sites?perPage=1` total 仍 381。
- [ ] **Step 5: 全量 + tsc + commit** `feat: 管理扩展 Task3——seed 三表化（friendlinks/navitems 显式 id），语义 round-trip 闸口`

---

### Task 4: friendlinks 路由（CRUD + batch-delete）

**Files:**
- Modify: `admin/src/routes.ts`（新路由段，插在 sites 段之后、categories 段之前）
- Test: `admin/test/routes.test.ts`（追加 describe，沿用该文件 unstable_dev + `CFG` 基建）

**Interfaces:**
- Consumes: Task 1 db 助手
- Produces: 端点族 `GET/POST /api/admin/friendlinks`、`PATCH/DELETE /api/admin/friendlinks/:id`、`POST /api/admin/friendlinks/batch-delete`（形状见 spec §3.1；UI Task 12 消费）

- [ ] **Step 1: 写失败测试**（路由集成，全部经 `worker.fetch`，Bearer devtok 沿用该文件既有 `AUTH` 常量）：

```ts
describe('/api/admin/friendlinks', () => {
  it('POST → 201 {friendlink 含 id}；GET 列出（按 sort,id）；PATCH 改 title 生效；DELETE 204；缺行 404', async () => { /* … */ });
  it('POST 校验：title/url 非空否则 400；url 不做 normalizeUrl（"/relative" 原样存）', async () => { /* … */ });
  it('batch-delete {ids} → {deleted:n}；ids 含非正整数 → 400；空数组 → 400', async () => { /* … */ });
});
```

三条用例各含完整断言体（executor 从上面签名展开，语义全在 spec §3.1，禁止静默放宽校验）。

- [ ] **Step 2: 跑红**。
- [ ] **Step 3: 实现路由段**：

```ts
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
  }
```

（路由匹配顺序：batch-delete 字面量段放在 `/:id` 正则之前，如上即是。）

- [ ] **Step 4: 跑绿 + 全量 + tsc + commit** `feat: 管理扩展 Task4——/api/admin/friendlinks CRUD 与批删`

---

### Task 5: navitems 路由（一层限制 + 原子批删）

**Files:**
- Modify: `admin/src/routes.ts`（friendlinks 段之后）
- Test: `admin/test/routes.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 db 助手（`countNavChildren/getNavitemById/allNavitems/insertNavitem/updateNavitem`）
- Produces: 端点族 `GET/POST /api/admin/navitems`、`PATCH/DELETE /api/admin/navitems/:id`、`POST /api/admin/navitems/batch-delete`（spec §3.2）

- [ ] **Step 1: 写失败测试**——行为清单（每条都是断言，executor 展开成 it）：
  1. POST 顶层 `{item:'首页',icon:'fa fa-home',link:'./'}` → 201，parent_id null；
  2. POST 子项 `{item:'Emoji',link:'./assets/emoji/',parent_id:父id}` → 201；GET 序=顶层按 sort,id 子项紧跟父；
  3. POST parent_id 指向**子项** → 400（一层封死）；指向不存在 → 400；
  4. PATCH 把父项改成 `parent_id=其子项` → 400（会成环/破层）；PATCH 子项 `parent_id:null` 升顶 → 400（有子项语义突变，提示删重建）；
  5. DELETE 有子项的顶层 → 400（message 含「子项」）；先删子项再删父 → 204/204；
  6. batch-delete：{父} 不含其子 → 400 整体拒（原子：GET 行数不变）；{父+全部子} → 200 deleted 全数；
  7. POST/PATCH item 非空校验；link 允许空串（纯下拉容器）。

- [ ] **Step 2: 跑红**。
- [ ] **Step 3: 实现**（与 routes.ts 中刚提交的 friendlinks 段同构：GET 全表 / POST 212 校验后 insert 回 201 单行 / `/:id` PATCH 白名单字段 + DELETE / batch-delete 先全量校验再删；都在同一文件可直接对照）；关键闸语如下，其余按 Step 1 行为清单展开：

```ts
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
```

（POST 用 `assertMount(parent_id)`；PATCH 用 `assertMount(parent_id, id)` 且 `body.parent_id === null` 且原行有子 → 400「请删除子项后再升顶」。）

- [ ] **Step 4: 跑绿 + 全量 + tsc + commit** `feat: 管理扩展 Task5——/api/admin/navitems CRUD，一层下拉限制与原子批删`

---

### Task 6: icon 决策链（icons.ts + ai icon 字段 + pipeline 补行）

**Files:**
- Create: `admin/src/icons.ts`
- Modify: `admin/src/ai.ts`（AiResult+validate+systemPrompt）
- Modify: `admin/src/pipeline.ts`（categories 缺行补位时给 icon）
- Test: `admin/test/icons.test.ts`（新建）、`admin/test/ai.test.ts`（追加，若无则并入 pipeline.test.ts）、`admin/test/pipeline.test.ts`（追加）

**Interfaces:**
- Consumes: `Env`（AI_* 配置）；`upsertCategory(cat.icon)`（既有）
- Produces: `DEFAULT_ICON: string`、`FA_CLASS: RegExp`、`iconFor(name: string): string`、`resolveIcon(name: string, env: Env, fetchImpl?: typeof fetch): Promise<string>`（icons.ts）；`AiResult.icon: string`（可为 ''）；Task 7 的 POST categories 消费 `resolveIcon`

- [ ] **Step 1: 写失败测试** icons.test.ts：

```ts
it('规则表命中（中/英、大小写）', () => {
  expect(iconFor('视频剪辑')).toBe('fas fa-film');
  expect(iconFor('Music 世界').startsWith('fas fa-')).toBe(true);
  expect(iconFor('AI合成')).toBe('fas fa-robot');
});
it('未命中 → 默认文件夹；规则命中即整类名（前缀 fas/far 按表）', () => {
  expect(iconFor('呸呸呸')).toBe(DEFAULT_ICON);
});
it('resolveIcon：未配 AI 落规则表（零网络）；配 AI 且返回合法类名 → 用 AI；AI 返回非法/超时/非 200 → 落规则表', async () => {
  const env = { AI_BASE_URL: 'https://ai.test/v1/', AI_API_KEY: 'k', AI_MODEL: 'm' } as Env;
  const ok = (content: unknown): typeof fetch => (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { headers: { 'content-type': 'application/json' } })) as never;
  expect(await resolveIcon('游戏娱乐', {} as Env, ok({ icon: 'fas fa-gamepad' }))).toBe('fas fa-gamepad'); // 未配置：无请求
  expect(await resolveIcon('游戏娱乐', env, ok({ icon: 'far fa-gamepad' }))).toBe('far fa-gamepad');
  expect(await resolveIcon('游戏娱乐', env, ok({ icon: 'javascript:alert(1)' }))).toBe(iconFor('游戏娱乐'));
  expect(await resolveIcon('游戏娱乐', env, (async () => { throw new Error('net'); }) as never)).toBe(iconFor('游戏娱乐'));
});
```

pipeline.test.ts 追加（routerFetch 基建复用）：AI 返回带 `icon:'fas fa-robot'` + new_category → 新建的 categories 行 icon=该值；AI 无 icon 字段 → 行 icon=`iconFor(分类名)`；**直通用例断言零网络不变**（现有 `calls).toEqual([])` 用例不许被破坏——直通补行只走 iconFor）。既有「默认分类」用例的 icon 断言从固定默认值改为 `iconFor('未分类')`（规则表未命中仍是默认值，实际不用改——核对后保持）。

- [ ] **Step 2: 跑红**。
- [ ] **Step 3: 实现 icons.ts**（规则表从 spec §5 誊全 30 条；比对序=表序，先命中先赢）：

```ts
// icon 决策链（spec-27 §5）：AI 优先 → 关键词规则表 → 默认。纯规则可离线测。
import type { Env } from './types';
export const DEFAULT_ICON = 'fas fa-folder-open fa-lg';
// 接受 fa / fas / far / fab 前缀 + 可选尺寸后缀；其余一律弃（防注入非类名串进前台模板）
export const FA_CLASS = /^fa[sbr]? fa-[a-z][a-z0-9]*(-[a-z0-9]+)*?( (xs|sm|lg|xl|2x|3x|4x|5x))?$/;
const RULES: ReadonlyArray<readonly [string[], string]> = [
  [['设计', '美工', '素材', 'design'], 'fas fa-palette'],
  [['视频', '影视', '剧集', '剪辑', 'video'], 'fas fa-film'],
  [['音乐', '歌曲', 'audio', 'music'], 'fas fa-music'],
  [['游戏', 'game'], 'fas fa-gamepad'],
  [['阅读', '书', '小说', 'book', 'read'], 'fas fa-book-open'],
  [['新闻', '资讯', '热榜', 'news'], 'fas fa-newspaper'],
  [['工具', '效率', 'tool'], 'fas fa-wrench'],
  [['ai', '智能', '机器'], 'fas fa-robot'],
  [['图片', '摄影', '图库', 'photo', 'image'], 'fas fa-image'],
  [['云盘', '资源', '软件', 'drive', 'cloud'], 'fas fa-cloud'],
  [['导航', '聚合', '综合', 'nav'], 'fas fa-compass'],
  [['购物', '电商', 'shop', 'store'], 'fas fa-shopping-cart'],
  [['开发', '代码', '编程', 'dev', 'code'], 'fas fa-code'],
  [['邮箱', '邮件', 'mail'], 'fas fa-envelope'],
  [['动漫', '二次元', '动画'], 'fas fa-masks-theater'],
  [['直播'], 'fas fa-video'],
  [['字幕', '配音'], 'fas fa-closed-captioning'],
  [['封面', '图文'], 'fas fa-image-portrait'],
  [['无人机', '航拍'], 'fas fa-helicopter'],
  [['模版', '模板', '插件'], 'fas fa-puzzle-piece'],
  [['虚拟', '主播'], 'fas fa-vr-cardboard'],
  [['学习', '教育', '词典', '课程'], 'fas fa-graduation-cap'],
  [['搜索', 'search'], 'fas fa-magnifying-glass'],
  [['社交', '社区', '论坛'], 'fas fa-comments'],
  [['地图', '出行', '旅游'], 'fas fa-map'],
  [['财经', '支付', '美元', '股票'], 'fas fa-coins'],
  [['播客', '电台', 'radio'], 'fas fa-podcast'],
  [['博客', '日志', 'blog'], 'fas fa-feather'],
  [['备用', '镜像'], 'fas fa-clone'],
  [['热门', '热'], 'fas fa-fire'],
];
export function iconFor(name: string): string {
  const n = name.toLowerCase();
  for (const [keys, icon] of RULES) if (keys.some((k) => n.includes(k))) return icon;
  return DEFAULT_ICON;
}
const AI_ICON_PROMPT =
  '仅输出 JSON {"icon":"..."}。为给定分类名从 Font Awesome 6 Free 选最贴切的一个类名（形如 fas fa-gamepad，可带尺寸后缀）；不确定就返回 fas fa-folder-open fa-lg。';
export async function resolveIcon(name: string, env: Env, fetchImpl: typeof fetch = fetch): Promise<string> {
  const { AI_BASE_URL, AI_API_KEY, AI_MODEL } = env;
  if (!AI_BASE_URL || !AI_API_KEY || !AI_MODEL) return iconFor(name); // 未配置零网络（本地 dev 常态）
  try {
    const res = await fetchImpl(`${AI_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
      body: JSON.stringify({ model: AI_MODEL, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: AI_ICON_PROMPT }, { role: 'user', content: name }] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return iconFor(name);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '') as { icon?: unknown };
    return typeof parsed.icon === 'string' && FA_CLASS.test(parsed.icon.trim()) ? parsed.icon.trim() : iconFor(name);
  } catch {
    return iconFor(name); // 单题小调用不值得重试：失败即落规则
  }
}
```

ai.ts 三处小改：① `AiResult` 加 `icon: string`（注释：''=AI 未给/不合法，仅弃本字段不弃整条结果）；② validate 尾部 `const icon = typeof o.icon === 'string' && FA_CLASS.test(o.icon.trim()) ? o.icon.trim() : '';` 并放进返回值；③ systemPrompt 追加一句 `可附 icon(Font Awesome 6 free 类名，如 fas fa-gamepad；new_category=true 时尽量给出)。`（import { FA_CLASS } from './icons'）。

pipeline.ts 补行处：

```ts
  if (!cats.some((c: CategoryRow) => c.taxonomy === taxonomy && c.term === term)) {
    // spec-27 §5 集成点 1：AI 给过合法 icon 用 AI 的；否则（含直通路径，零网络不变）纯规则表
    const icon = aiIcon || iconFor(`${taxonomy} ${term}`);
    await upsertCategory(db, { taxonomy, term, icon });
  }
```

（`aiIcon` = 非直通分支里 `aiOk?.icon ?? ''`；直通分支不触 AI 所以恒 `iconFor`。在两个分支各声明一次。）

- [ ] **Step 4: 跑绿 + 全量 + tsc + commit** `feat: 管理扩展 Task6——icon 决策链（AI 优先+规则表兜底+默认），AI 结果可选 icon 字段`

---

### Task 7: categories 端点进化 + prune 退场（R4）

**Files:**
- Modify: `admin/src/routes.ts`（categories 段重写 + 3 处 prune 调用删除）
- Modify: `admin/src/extension.ts`（2 处 prune 调用删除）
- Modify: `admin/src/category.ts`（删 `pruneOrphanCategories` 函数，注释注明退场理由）
- Modify: `admin/src/db.ts`（`getCategory(db,taxonomy,term)` 助手）
- Test: `admin/test/category.test.ts`（prune describe 整段替换为「退场断言」）、`admin/test/routes.test.ts`（categories CRUD 新 describe）

**Interfaces:**
- Consumes: Task 1 `renameTaxonomy/renameTerm/countSitesByPair/countSitesByTaxonomy`、Task 6 `resolveIcon`
- Produces: `GET categories` 行附 `siteCount`；`POST` 201 `{category}`；`PATCH /api/admin/categories`；`DELETE` 守卫；`POST /api/admin/categories/batch-delete`（UI Task 11 消费）

- [ ] **Step 1: 写失败测试**（routes.test.ts describe「categories 管理」，unstable_dev 基建沿用）：
  1. GET：造 pair（1 站点+categories 行）→ `categories[i].siteCount===1`，`shapes` 原样在；
  2. POST 带 icon → 201 `{category}` 回显 icon/sort；POST 缺 icon 且无 AI 配置 → icon=`iconFor(名)`（规则命中「游戏」→fa-gamepad）；
  3. PATCH 改 taxonomy：`{taxonomy:'旧',new:{taxonomy:'新'}}` → categories header+子行、sites 全改；目标撞名（union 已有'新'）→ 400；只改 icon/sort → 仅动 categories；
  4. PATCH 改 term：(tax,'子甲')→'子乙'，sites 跟随；目标 (tax,'子乙') 已存在 → 400；
  5. DELETE 非空 pair → 400（message 含条数）；空 pair 的 term 行 → 204；header 行：该 taxonomy 有任意站点 → 400，零站点 → 204 且**子分类行连带消失**；
  6. batch-delete：含一个非空 pair → 400 且一个都没删（原子）；全空 → 200 `{deleted:n}`；
  7. **prune 退场**：DELETE 某站点行的最后一个站点 → `GET categories` 该 pair 行仍在、`siteCount=0`（替换旧「孤儿被 prune」断言，reanalyze 两终点的 prune 断言同步改「不删」）。

- [ ] **Step 2: 跑红**。
- [ ] **Step 3: 实现**。routes.ts categories 段完整替换（POST 的形态闸逻辑保留，追加 icon 缺省 `resolveIcon` + 201 回显）：

```ts
    if (req.method === 'GET') {
      // siteCount：spec-27 §3.3——任意 status（与形态权威口径一致）；子查询按 pair 精确匹配
      const cats = await db.prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM sites s WHERE s.taxonomy = c.taxonomy AND s.term = c.term) AS siteCount
         FROM categories c ORDER BY c.taxonomy, c.term`,
      ).all<CategoryRow & { siteCount: number }>();
      // …shapes 计算原样保留…
      return json({ categories: cats.results, shapes });
    }
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const tax = typeof body?.taxonomy === 'string' ? body.taxonomy.trim() : '';
      const term = typeof body?.term === 'string' ? body.term.trim() : '';
      const nw = (body?.new ?? {}) as Record<string, unknown>;
      if (!tax) return fail('bad_request', '需要 {taxonomy,term,new:{taxonomy?,term?,icon?,sort?}}');
      const pairs = await categoryShapePairs(db);
      const exists = (t: string, m: string) => pairs.some((x) => x.taxonomy === t && x.term === m);
      if (!exists(tax, term)) return jsonError('bad_request', '分类行不存在', 404);
      const nTax = typeof nw.taxonomy === 'string' ? nw.taxonomy.trim() : tax;
      const nTerm = typeof nw.term === 'string' ? nw.term.trim() : term;
      if (nTax === tax && nTerm === term) {
        if (typeof nw.icon === 'string' && nw.icon.trim() !== '') {
          if (!FA_CLASS.test(nw.icon.trim())) return fail('bad_request', 'icon 需为 Font Awesome 类名（fas/far/fab fa-name）');
          await db.prepare('UPDATE categories SET icon = ? WHERE taxonomy = ? AND term = ?').bind(nw.icon.trim(), tax, term).run();
        }
        if (typeof nw.sort === 'number' && Number.isFinite(nw.sort))
          await db.prepare('UPDATE categories SET sort = ? WHERE taxonomy = ? AND term = ?').bind(Math.trunc(nw.sort), tax, term).run();
        return json({ category: await getCategory(db, tax, term) });
      }
      // 改名（taxonomy 或 term 或双双）：目标任一源已存在 → 拒（不隐式合并，spec-27 §1 非目标）
      if (exists(nTax, nTerm) || (nTerm === '' && exists(nTax, ''))) return fail('bad_request', `目标「${nTax}/${nTerm}」已存在：不提供隐式合并，请先手动搬移站点`);
      if (nTax !== tax) await renameTaxonomy(db, tax, nTax);
      if (nTerm !== term) await renameTerm(db, nTax, term, nTerm); // term 改名在 taxonomy 改名之后（定位已迁移的行）
      return json({ category: await getCategory(db, nTax, nTerm) });
    }
```

DELETE 段加守卫与整类级联；`POST /api/admin/categories/batch-delete` 原子循环（先全量校验 `countSitesByPair` / header 用 `countSitesByTaxonomy`，任一受阻 → 400 列全阻塞，否则逐条删）。**prune 退场**：删 routes.ts:150/258/266/271 与 extension.ts 两处调用及 import；category.ts 删函数，原位置注释：

```ts
// pruneOrphanCategories 已于管理扩展轮退场（spec-27 裁决 R4）：categories 行升为一等公民，
// 手动新建的空分类不得被自动误杀；空分类由分类管理页显式删除。写入口形态归一（resolveCategoryShape）不变。
```

`db.ts` 加 `export async function getCategory(db: D1Database, taxonomy: string, term: string): Promise<CategoryRow | null>`（SELECT * WHERE 双键）。reanalyze/DELETE 旧断言按 Step 1.7 反转。

- [ ] **Step 4: 跑绿 + 全量 + tsc + commit** `feat: 管理扩展 Task7——categories 一等公民：siteCount/改名级联/非空禁删/原子批删；prune 退场（R4）`

---

### Task 8: sites/batch-delete 三形态

**Files:**
- Modify: `admin/src/routes.ts`（sites 段追加；**置于** `/api/admin/sites/:id` 正则分支之前）
- Test: `admin/test/routes.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 `deleteSitesByIds/deleteSitesByFilter`
- Produces: `POST /api/admin/sites/batch-delete`，体三形态：`{ids:[…]}` xor `{filter:{q?,status?,taxonomy?,term?}}` xor `{wipe:'全部删除'}` → `{deleted:n}`（UI Task 10 消费）

- [ ] **Step 1: 写失败测试**：
  1. `{ids:[a,b]}` → `{deleted:2}`，行消失；含不存在 id → deleted 按实删（不报错）；
  2. `{filter:{taxonomy:'筛甲'}}` 只删该分类；`{filter:{q:'关键词'}}` LIKE 同 GET 语义（转义一致）；
  3. `{wipe:'全部删除'}` → 全库删；`{wipe:'手滑'}` → 400；`{}` 空对象 → 400（**必须显式形态**，防无参误删）；
  4. `ids` 非数组/含 0/负数/小数 → 400；`{ids:[…] 与 filter 同现}` → 400（互斥）。
- [ ] **Step 2: 跑红**。
- [ ] **Step 3: 实现**：

```ts
  if (p === '/api/admin/sites/batch-delete' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body) return fail('bad_request', '需要 JSON 对象');
    const forms = [body.wipe !== undefined, Array.isArray(body.ids), body.filter !== undefined];
    if (forms.filter(Boolean).length !== 1) return fail('bad_request', '需三选一：{ids:[…]} | {filter:{…}} | {wipe:"全部删除"}');
    if (body.wipe !== undefined) {
      if (body.wipe !== '全部删除') return fail('bad_request', '清空全库需 {wipe:"全部删除"} 逐字确认');
      return json({ deleted: await deleteSitesByFilter(db, {}) });
    }
    if (Array.isArray(body.ids)) {
      const ids = body.ids as unknown[];
      if (!ids.length || !ids.every((n) => Number.isInteger(n) && (n as number) > 0)) return fail('bad_request', 'ids 需为非空正整数数组');
      return json({ deleted: await deleteSitesByIds(db, ids as number[]) });
    }
    const f = body.filter as Record<string, unknown>;
    if (typeof f !== 'object' || f === null) return fail('bad_request', 'filter 需为对象');
    const s = (k: 'q' | 'status' | 'taxonomy' | 'term') => (typeof f[k] === 'string' && (f[k] as string) !== '' ? (f[k] as string) : undefined);
    return json({ deleted: await deleteSitesByFilter(db, { q: s('q'), status: s('status'), taxonomy: s('taxonomy'), term: s('term') }) });
  }
```

- [ ] **Step 4: 跑绿 + 全量 + tsc + commit** `feat: 管理扩展 Task8——sites 批删三形态（ids/filter/wipe 互斥，wipe 逐字确认）`

---

### Task 9: doPublish 三文件化

**Files:**
- Modify: `admin/src/publish.ts`
- Modify: `admin/src/db.ts`（如需 `allFriendlinks/allNavitems` 之外助手——不新增即可）
- Test: `admin/test/publish.test.ts`（改造既有 + 追加；fake fetch 的 GitHub 路由按 path 分发三份文件）

**Interfaces:**
- Consumes: Task 2 builders、Task 1 表数据、github.ts（不动）
- Produces: `doPublish` 返回 `{ ok: true; commitUrl; count; friendlinks: number; navitems: number; files: { path: string; action: 'put' | 'skip' }[] }`（routes 的 publish 响应壳透传新字段；UI Task 10 起发布弹窗可读）

- [ ] **Step 1: 写失败测试**（要点全部为断言）：
  1. 三文件全等 → 零 PUT、`files` 全 skip、pending 照常翻转（幂等短接扩为三文件版）；
  2. 仅 webstack 变 → 一个 PUT，commit message 站点数不变；
  3. 仅 friendlinks 变 → 只 PUT friendlinks.yml，webstack skip；
  4. 骤降/0 行闸行为不变（仍只对 webstack 快照生效，远端 friendlinks 再小也不触发）；
  5. 中途 409：webstack PUT 成功后 friendlinks 409 且对账不等 → `github_conflict`，message 含「1 个文件已更新」，**pending 不翻转**；
  6. 409 对账相等 → 视为 skip 继续；
  7. ghGet 预检任一文件 404（远端不存在该 path）→ 按「需要新建」处理：PUT 用 `sha:null`? ——现有 ghPut 签名收 sha；GitHub Contents API 新建文件 GET 404 后 PUT 不带 sha。github.ts `ghPut(repo, path, content, sha, …)`：sha 传 `''`/`null` 时的行为核对实现，测试用 fake fetch 复现 404→PUT（无 sha 头）即可，若 ghPut 不支持新建则**本任务内扩展 ghPut**（`sha: string | null`，null=省略 sha 字段）。
- [ ] **Step 2: 跑红**。
- [ ] **Step 3: 实现**（doPublish 中段重写；闸口、翻转时机、消息格式保持）：

```ts
type YmlFile = { path: string; content: string };
// …快照构建与 webstack 闸一（0 行）保持原位…
const flinks = await allFriendlinks(db);
const navs = await allNavitems(db);
const files: YmlFile[] = [
  { path: PATH, content: yml },
  { path: 'data/friendlinks.yml', content: buildFriendlinksYml(flinks) },
  { path: 'data/headers.yml', content: buildNavYml(navs) },
];
let lastCommitUrl = '';
const actions: { path: string; action: 'put' | 'skip' }[] = [];
try {
  const remotes = await Promise.all(files.map(async (f) => {
    try { return await ghGet(repo, f.path, token, fetchImpl); }
    catch (e) { if (e instanceof GithubApiError && e.status === 404) return { sha: null, text: null }; throw e; }
  }));
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!, remote = remotes[i]!;
    if (i === 0 && remote.text !== null) {
      // 骤降闸只对 webstack：基线=远端现文
      const remoteCount = countRemoteEntries(remote.text);
      if (remoteCount >= MIN_REMOTE_FOR_RATIO_GATE && snapshot.length * 2 < remoteCount)
        return { ok: false, code: 'bad_request', message: `快照仅 ${snapshot.length} 条站点，不足远端 ${remoteCount} 条的一半，疑似误发布，已拒绝（请核对 D1 数据后重试）` };
    }
    if (remote.text === f.content) { actions.push({ path: f.path, action: 'skip' }); continue; }
    try {
      lastCommitUrl = await ghPutWithReconcile(repo, f, remote.sha, fileMessage(f, i, snapshot.length, pending.length, flinks.length, navs.length), token, fetchImpl);
      actions.push({ path: f.path, action: 'put' });
    } catch (e) {
      if (e instanceof PublishConflictAbort) {
        return { ok: false, code: 'github_conflict', message: `发布中止于 ${f.path}：${actions.filter((a) => a.action === 'put').length} 个文件已更新，${files.length - actions.length} 个未更新。重试点发布可收敛（内容比对幂等）。${e.message}` };
      }
      throw e;
    }
  }
} catch (e) { /* 同旧：GithubApiError 等 → fetch_failed「GitHub 读写失败，发布未生效」 */ }
await markPendingPublished(db, pending.map((r) => r.id));
return { ok: true, commitUrl: lastCommitUrl || `https://github.com/${repo}/blob/main/${PATH}`, count: snapshot.length, friendlinks: flinks.length, navitems: navs.length, files: actions };
```

`ghPutWithReconcile`：PUT → 409 时重 GET 对账，等=skip 语义返回 blob URL，不等=抛 `PublishConflictAbort`（新内部类）。`fileMessage`：`data/webstack.yml`=旧格式 `后台发布：N 条站点（M 条新增）`；另两个 `后台发布：友情链接 X 条` / `后台发布：顶部导航 Y 项`。幂等短接旧逻辑并入 skip（旧「全 skip 提前返回」删掉——现在 skip 后仍走翻转，语义等价）。

routes.ts publish 响应与 README/publish 弹窗文案适配：`{ ...r, files }` 透出（routes 现直接 `json({ commitUrl, count })`——改为透传全字段）。

- [ ] **Step 4: 跑绿 + 全量 + tsc + commit** `feat: 管理扩展 Task9——发布三文件化（预检-幂等 skip-逐文件 PUT-冲突收敛），ghPut 支持新建文件（sha 可空）`

---

### Task 10: UI——confirmModal + 列表页删除族

**Files:**
- Modify: `admin/public/index.html`（列表工具栏按钮）
- Modify: `admin/public/admin.js`（modal 基建 + 选择态 + 三按钮）
- Modify: `admin/public/style.css`（modal、勾选列、危险按钮、移动端）

**Interfaces:**
- Consumes: Task 8 端点、GET total
- Produces: `confirmModal(opts): Promise<boolean>`（Task 11/12 复用）；`sel: Set<number>` 选择态与 `renderChecks()`

- [ ] **Step 1: index.html 工具栏**（`#filters` 行内 publish 按钮前加）：

```html
<button id="del-sel" type="button" disabled>删除选中 (0)</button>
<button id="del-filter" type="button" class="danger" disabled>按筛选全删</button>
<button id="del-wipe" type="button" class="danger">清空全库</button>
```

表头 checkbox 由 JS 在 buildTable 里 createElement（不写死进 HTML，行渲染同步 `data-id`）。

- [ ] **Step 2: admin.js 新代码**（完整函数体，锚点=「视图切换」段之后）：

```js
// ── confirmModal（spec-27 §7）：多行删除统一弹窗；requireText 逐字解锁；零 innerHTML ──
const modalHost = document.createElement('div'); modalHost.id = 'modal-host'; document.body.appendChild(modalHost);
function confirmModal({ title, lines = [], danger = false, requireText = '' }) {
  return new Promise((resolve) => {
    modalHost.replaceChildren();
    const back = el('div', 'modal-back');
    const box = el('div', 'modal');
    box.appendChild(el('h3', danger ? 'modal-title danger' : 'modal-title', title));
    for (const l of lines) box.appendChild(el('p', 'modal-line', l));
    let input = null;
    if (requireText) { input = el('input'); input.type = 'text'; input.placeholder = `输入「${requireText}」解锁`; }
    const ok = el('button', danger ? 'primary danger' : 'primary', '确认');
    ok.disabled = !!requireText;
    const cancel = el('button', '', '取消');
    const close = (v) => { document.removeEventListener('keydown', onKey); modalHost.replaceChildren(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    ok.onclick = () => close(true);
    cancel.onclick = () => close(false);
    back.onclick = (e) => { if (e.target === back) close(false); };
    if (input) input.oninput = () => { ok.disabled = input.value !== requireText; };
    box.append(input ?? document.createDocumentFragment(), ok, cancel);
    back.appendChild(box); modalHost.appendChild(back); document.addEventListener('keydown', onKey);
    (input ?? ok).focus();
  });
}
```

选择态与按钮逻辑：`const sel = new Set();` buildRow 前置 checkbox（`onchange` 增删 `sel`，按钮文案 `删除选中 (${sel.size})`，`loadList` 开头 `sel.clear()` 防翻页幽灵选择）；

```js
async function deleteFlow(body, summaryLines, { danger = false, requireText = '' } = {}) {
  const ok = await confirmModal({ title: '确认删除？', lines: summaryLines, danger, requireText });
  if (!ok) return;
  const r = await api('sites/batch-delete', { method: 'POST', body: JSON.stringify(body) });
  toast(`已删除 ${r.deleted} 条（前台生效需再点批量发布）`); loadList(); loadTaxonomies();
}
$('del-sel').onclick = () => {
  const ids = [...sel];
  deleteFlow({ ids }, [`共 ${ids.length} 条选中站点。`]);
};
$('del-filter').onclick = () => {
  const f = { ...listState }; delete f.page; delete f.perPage;
  const filter = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
  deleteFlow({ filter }, [`当前筛选命中 ${lastTotal} 条（${filterDesc()}）。`, '分类下站点被清空后，其分类行会留在分类页（可去分类页删）。']);
};
$('del-wipe').onclick = () => deleteFlow({ wipe: '全部删除' }, ['将清空 D1 中全部站点行（不限筛选）。', '前台内容在下一次批量发布前不变；发布有 0 行/骤降闸兜底。'], { danger: true, requireText: '全部删除' });
```

（`lastTotal`=loadList 记录的 total；`filterDesc()` 拼当前筛选文字；`loadList` 里按钮 disabled 态联动 `sel.size` 与 `lastTotal>0`。）行内单删保留现有 `confirm()`，但删后刷新逻辑不变。

- [ ] **Step 3: style.css**：`.modal-back`（fixed inset:0、遮罩 rgba、z-index 70）、`.modal`（surface 令牌、max-width 26rem、圆角阴影）、`.modal-line`、`button.danger`（#f1404b 底/描边两档）、`.chk-col`（宽 1.8rem；移动卡片布局进头行左角）、`#modal-host input`（复用现 input 样式）。移动端 `@media (max-width: 760px)` 弹窗 `width: min(92vw, 26rem)`。
- [ ] **Step 4: 浏览器自验**（dev server 已在 8791；`/admin` 登录 devtok）：勾选→批删弹窗→删 2 条；「清空全库」requireText 不输入时确认钮禁用、输入后可删；Esc/外点关闭。**测试数据先 `npm run seed`+`--local` 重灌兜底。**
- [ ] **Step 5: 全量 + tsc + commit** `feat: 管理扩展 Task10——confirmModal 与列表删除族（勾选批删/筛选全删/清空全库）`

---

### Task 11: UI——分类页（CRUD + 改名联动 + 批删 + 自动 icon 回显）

**Files:**
- Modify: `admin/public/index.html`（nav 按钮 + `#view-categories` 区块）
- Modify: `admin/public/admin.js`（视图注册 + 全函数）
- Modify: `admin/public/style.css`（分类表分组样式）

**Interfaces:**
- Consumes: Task 7 端点（siteCount/PATCH/batch-delete）、Task 6 resolveIcon 结果（POST 201 回显）、既有 `attachCombo/allTaxonomies/termsFor`
- Produces: `#view-categories` 完整视图

- [ ] **Step 1: index.html**：`#tabs` 追加 `<button type="button" data-view="categories">分类</button>`（列表之后）；`<main>` 内加区块：表容器 `#cat-table` + 新建行 `#cat-new`（`#cat-new-tax`（combo）、`#cat-new-term`（combo，级联）、`#cat-new-icon`（文本+▾ 候选=现有 icon 集，自动预填可改）、按钮 `#cat-new-go`、批删 `#cat-del-sel`）。admin.js showView 分支接入 `loadCategories()`。
- [ ] **Step 2: admin.js 渲染与联动**（要点即断言，函数签名固定如下，实现按既有 buildRow 风格）：

```js
let catRows = [];              // GET categories 的 categories（含 siteCount）
async function loadCategories() { /* GET → catRows → renderCategories(); 失败 toast 复用 */ }
function renderCategories() {
  // 顶层行（term==''）按 sort 排；其子行（taxonomy 相同、term!=''）紧随、按 sort 排；
  // union 里只在 sites 出现的 pair（无 categories 行）以灰条「（未登记）」渲染在组尾（不可删只能先补登记）——
  //   数据源=同响应 shapes。每行：勾选框、taxonomy/term 文本、icon 输入、sort 数字输入、
  //   siteCount 徽章（>0 蓝底），操作列「保存」「删除」。
}
async function saveCat(row, next) { /* PATCH {taxonomy,term,new:{…diff 字段…}}；400（撞名/非空删）→ toast 后端 message 原文 */ }
async function delCat(row) { /* DELETE ?taxonomy&term；400 → toast（含条数） */ }
$('cat-new-tax').addEventListener('input', () => { autoIconPreview(); addTermSync(); }); // icon 框空则实时 iconFor 前端镜像：直接抄后端规则表关键 12 条做轻量预览？ 不——
```

**icon 预览不复制规则表**（防漂移）：新建表单点「添加」→ POST 缺 icon → 后端 201 回显 `category.icon` → 回填 icon 输入框并 toast「已自动配 icon」，用户可改后再 PATCH 一次。这是唯一回显路径，前端零规则。
保存成功后：若改的是 taxonomy/term → `loadTaxonomies(); loadList();`（筛选下拉与列表同步，spec 联动语义）。

- [ ] **Step 3: style.css**：`.cat-child {padding-left:1.6rem}`、`.cat-unnamed {opacity:.6}`、siteCount 徽章 `.cnt`、分组间隔。
- [ ] **Step 4: 浏览器自验**：改「媒体创作」名→列表 taxonomy 下拉与行内值同步；删非空分类→toast 带条数拒；新建「游戏娱乐」→自动 icon `fas fa-gamepad` 回显；勾两个空子分类批删成功。截图 /tmp/ui-cats.png。
- [ ] **Step 5: 全量 + tsc + commit** `feat: 管理扩展 Task11——分类管理页（siteCount/改名级联回显/非空禁删/批删/自动 icon）`

---

### Task 12: UI——友链页 + 导航页

**Files:**
- Modify: `admin/public/index.html`（两 tab + 两区块）
- Modify: `admin/public/admin.js`
- Modify: `admin/public/style.css`

- [ ] **Step 1: index.html**：tabs 追加 友链（data-view="friends"）、导航（data-view="navs"）；区块各含表容器 + 新增表单（友链：title/url/description；导航：item/icon/link/父项下拉）+ `#fr-del-sel` / `#nv-del-sel`。
- [ ] **Step 2: admin.js**：两视图同构——`loadFriends/renderFriends/saveFriend/delFriend`、`loadNavs/renderNavs/saveNavitem/delNavitem`；导航表子项缩进（复用 `.cat-child`），「父项」下拉只列顶层（含「（无）」=顶层）；全部多行删除走 `confirmModal`，单行走 `confirm`；文案提示「前台生效需再点批量发布」。
- [ ] **Step 3: style.css**：复用 modal/卡片样式，补 `#view-navs select.parent` 宽度。
- [ ] **Step 4: 浏览器自验**：三表各加一行、改一行、批删两行（弹窗）；导航子项挂父、删父被 400 的 toast 文案。截图双视口。
- [ ] **Step 5: 全量 + tsc + commit** `feat: 管理扩展 Task12——友链页与顶部导航页 CRUD`

---

### Task 13: README 手册 + 终验

**Files:**
- Modify: `admin/README.md`（API 表、seed 步骤、发布步骤、首次 churn 注记）

- [ ] **Step 1: README**：端点清单补 §3.1–§3.4 新路由；部署步骤 6 的 seed 行注「五表全量替换」；发布步骤注「首版会一次性重写 friendlinks.yml/headers.yml 格式（语义不变，预期内 churn）」；远程 D1 迁移前置：`wrangler d1 execute navdata --remote --file=./schema.sql` 必须先于新代码发布（spec §9）。
- [ ] **Step 2: 全量终验**：`npm test && npx tsc --noEmit`；dev server 重启后 381 行 seed 在位；六 tab 双视口截图（390px iframe 法）；发布干跑（本地 fake 不触真 GitHub：routes 测试已覆盖）。
- [ ] **Step 3: commit** `docs: 管理扩展 Task13——README 手册同步（五表 seed、三文件发布、迁移前置）`

---

## Self-Review（计划对 spec 的覆盖清单）

- spec §2 两表 → T1；§3.1→T4；§3.2→T5；§3.3→T6/T7；§3.4→T8；§4 发布→T9（builders T2）；§5 icon→T6；§6 seed→T3；§7 UI→T10/11/12；§8 测试散布各任务红绿步；§9 运维→T13 README + 全局约束「远程用户放行」。R1–R4：R1=T3/T9、R2=T8/T10、R3=T6、R4=T7（prune 退场断言）。
- 类型一致性：`FriendlinkRow/NavitemRow` 贯穿 T1/2/3/4/5/9；`confirmModal` 在 T10 定义、T11/12 消费；`resolveIcon/iconFor/FA_CLASS` T6 定义、T7（POST icon）消费。
- 已知偏差声明：T11 icon 预览否决了前端复制规则表的路径（防漂移），以后端 201 回显为唯一路径。
