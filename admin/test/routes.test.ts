// spec §6 核心路由集成测试：按 brief Step 3 用 wrangler unstable_dev 起真实 Worker
// （本地 D1 sqlite，vars 见 test/wrangler.routes.json，ADMIN_TOKEN='t'）。
// schema 初始化走 `wrangler d1 execute --local`（同一 persist 目录），与部署路径一致。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { unstable_dev } from 'wrangler';
import { handleAdmin } from '../src/routes';
import type { Unstable_DevWorker as UnstableDevWorker } from 'wrangler';
import type { Env, SiteRow } from '../src/types';

const CFG = 'test/wrangler.routes.json';
const PERSIST = '.wrangler-test';
const fixtureHtml = readFileSync('test/fixtures/bookmarks.chrome.html', 'utf8');
const auth = { Authorization: 'Bearer t' };
const authJson = { ...auth, 'Content-Type': 'application/json' };

let dev: UnstableDevWorker;

beforeAll(async () => {
  rmSync(PERSIST, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    ['./node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'navdata-test', '--local', `--persist-to=./${PERSIST}`, '--file=./schema.sql', `--config=./${CFG}`],
    { stdio: 'pipe' },
  );
  dev = await unstable_dev('./src/index.ts', { config: `./${CFG}`, local: true, ip: '127.0.0.1', port: 0, persistTo: `./${PERSIST}` });
}, 180_000);

afterAll(async () => {
  await dev?.stop();
  rmSync(PERSIST, { recursive: true, force: true });
});

const post = (path: string, body: unknown, headers: Record<string, string> = authJson) =>
  dev.fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
const getJson = async (res: { json(): Promise<unknown> }) => (await res.json()) as Record<string, any>;

describe('/api/admin 鉴权', () => {
  it('无 token / 错 token → 401 {error:unauthorized}', async () => {
    // 注：requireAuth（Task 1 既定语义）仅剥 `Bearer ` 前缀，裸 token 't' 也会通过，故只用真错误凭据
    for (const headers of [{}, { Authorization: 'Bearer nope' }, { Authorization: 'Basic dG9uZXNoYW8=' }] as const) {
      const res = await dev.fetch('/api/admin/sites', { headers });
      expect(res.status).toBe(401);
      expect(await getJson(res)).toMatchObject({ error: 'unauthorized' });
    }
  });
  it('非 /api/admin 路径不由 handleAdmin 接管（null 透传），index 兜底为真 404（Task 12：废除 200 ok 占位）', async () => {
    const res = await dev.fetch('/api/other');
    expect(res.status).toBe(404);
    expect(await getJson(res)).toMatchObject({ error: 'bad_request' }); // spec §8 统一 {error,message} 外壳
  });
});

describe('/api/admin/sites CRUD', () => {
  it('POST {url:"javascript:alert(1)"} → 400 bad_request', async () => {
    const res = await post('/api/admin/sites', { url: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
    expect(await getJson(res)).toMatchObject({ error: 'bad_request' });
  });
  it('POST 新 URL → 201 {site}（抓取降级 title=host，status=pending）', async () => {
    const res = await post('/api/admin/sites', { url: 'Http://Single.Invalid/p', taxonomy: 'RT筛选' });
    expect(res.status).toBe(201);
    const { site } = await getJson(res);
    expect(site).toMatchObject({ url: 'http://single.invalid/p', taxonomy: 'RT筛选', status: 'pending', source: 'manual' });
    expect(typeof site.id).toBe('number');
  });
  it('重复 URL（规范化后）→ 409 dup_url', async () => {
    const res = await post('/api/admin/sites', { url: 'http://single.invalid/p/' });
    expect(res.status).toBe(409);
    expect(await getJson(res)).toMatchObject({ error: 'dup_url' });
  });
  it('GET 列表：{sites,total,page,perPage} + status/taxonomy/page 筛选', async () => {
    await post('/api/admin/sites', { url: 'https://rt2.invalid', taxonomy: 'RT筛选' });
    const res = await dev.fetch('/api/admin/sites?taxonomy=RT筛选', { headers: auth });
    const list = await getJson(res);
    expect(list.total).toBe(2);
    expect(list.sites.length).toBe(2);
    expect(list.sites[0].url).toBe('https://rt2.invalid'); // id DESC：后插入的 rt2 在前
    const one = await getJson(await dev.fetch('/api/admin/sites?taxonomy=RT筛选&perPage=1&page=2', { headers: auth }));
    expect(one.total).toBe(2);
    expect(one.sites.length).toBe(1);
    const q = await getJson(await dev.fetch('/api/admin/sites?q=rt2', { headers: auth }));
    expect(q.total).toBe(1);
  });
  it('GET 列表：term 子分类精确筛选（嵌套分类先建形，term 才不被归一空置）', async () => {
    await post('/api/admin/sites', { url: 'https://tf-a.invalid', taxonomy: 'TF筛选', term: '子甲' });
    await post('/api/admin/sites', { url: 'https://tf-b.invalid', taxonomy: 'TF筛选', term: '子乙' });
    await post('/api/admin/sites', { url: 'https://tf-c.invalid', taxonomy: 'TF筛选' });
    const all = await getJson(await dev.fetch('/api/admin/sites?taxonomy=TF筛选', { headers: auth }));
    expect(all.total).toBe(3);
    const jia = await getJson(await dev.fetch('/api/admin/sites?taxonomy=TF筛选&term=%E5%AD%90%E7%94%B2', { headers: auth }));
    expect(jia.total).toBe(1);
    expect(jia.sites[0].url).toBe('https://tf-a.invalid');
    // term 单独可用（跨分类）；term='' 视同不过滤
    const termOnly = await getJson(await dev.fetch('/api/admin/sites?term=%E5%AD%90%E4%B9%99', { headers: auth }));
    expect(termOnly.total).toBe(1);
    const empty = await getJson(await dev.fetch('/api/admin/sites?taxonomy=TF筛选&term=', { headers: auth }));
    expect(empty.total).toBe(3);
  });
  it('PATCH 白名单：改 title/status/sort 生效；url 更新（服务端规范化 + url_raw 兜底同步，Task 9/10 裁定a）；id 等白名单外键仍忽略', async () => {
    const id = (await getJson(await post('/api/admin/sites', { url: 'https://patchme.invalid' }))).site.id;
    const res = await dev.fetch(`/api/admin/sites/${id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ title: '补丁题', status: 'published', sort: 5, url: ' HTTPS://PatchMe.Invalid/x ', id: 999 }) });
    expect(res.status).toBe(200);
    const { site } = await getJson(res);
    expect(site).toMatchObject({ id, title: '补丁题', status: 'published', sort: 5, url: 'https://patchme.invalid/x', url_raw: 'HTTPS://PatchMe.Invalid/x' });
  });
  it('PATCH url 非法 → 400；url 撞已有行 → 409 dup_url 且原行不动', async () => {
    const a = (await getJson(await post('/api/admin/sites', { url: 'https://patcha.invalid' }))).site.id;
    await post('/api/admin/sites', { url: 'https://patchb.invalid' });
    expect((await dev.fetch(`/api/admin/sites/${a}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ url: 'javascript:alert(1)' }) })).status).toBe(400);
    const dup = await dev.fetch(`/api/admin/sites/${a}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ url: 'https://patchb.invalid' }) });
    expect(dup.status).toBe(409);
    expect(await getJson(dup)).toMatchObject({ error: 'dup_url' });
    const list = await getJson(await dev.fetch('/api/admin/sites?q=patcha', { headers: auth }));
    expect(list.sites[0]).toMatchObject({ id: a, url: 'https://patcha.invalid' });
  });
  it('PATCH 非法 status / 空补丁 / 不存在 id → 400/404', async () => {
    const id = (await getJson(await post('/api/admin/sites', { url: 'https://patchbad.invalid' }))).site.id;
    expect((await dev.fetch(`/api/admin/sites/${id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ status: 'x' }) })).status).toBe(400);
    expect((await dev.fetch(`/api/admin/sites/${id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ zz: 1 }) })).status).toBe(400);
    expect((await dev.fetch('/api/admin/sites/999999', { method: 'PATCH', headers: authJson, body: JSON.stringify({ title: 'y' }) })).status).toBe(404);
    expect((await dev.fetch('/api/admin/sites/abc', { method: 'PATCH', headers: authJson, body: JSON.stringify({ title: 'y' }) })).status).toBe(400);
  });
  it('DELETE → 204 且行消失', async () => {
    const id = (await getJson(await post('/api/admin/sites', { url: 'https://delme.invalid' }))).site.id;
    const res = await dev.fetch(`/api/admin/sites/${id}`, { method: 'DELETE', headers: auth });
    expect(res.status).toBe(204);
    expect((await getJson(await dev.fetch('/api/admin/sites?q=delme', { headers: auth }))).total).toBe(0);
    expect((await dev.fetch('/api/admin/sites/999999', { method: 'DELETE', headers: auth })).status).toBe(204); // 幂等
  });
  it('POST :id/analyze 重跑流水线：标题重算但保留 status/sort/url_raw，id 变化', async () => {
    // url_raw=原样输入（含大小写/尾斜杠），url=规范化键——重分析后 url_raw 必须存活不被覆盖
    const created = (await getJson(await post('/api/admin/sites', { url: 'HTTPS://Reanalyze.Invalid/Keep', title: '初始题' }))).site;
    await dev.fetch(`/api/admin/sites/${created.id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ status: 'published', sort: 3 }) });
    const res = await post(`/api/admin/sites/${created.id}/analyze`, {});
    expect(res.status).toBe(200);
    const { site } = await getJson(res);
    expect(site.id).not.toBe(created.id);
    expect(site).toMatchObject({ url: created.url, url_raw: created.url_raw, status: 'published', sort: 3 });
    expect(site.title).not.toBe('初始题'); // 重跑不带旧显式字段 → 降级题（host）
    await dev.fetch(`/api/admin/sites/${site.id}`, { method: 'DELETE', headers: auth }); // 清理
  });
  it('POST :id/analyze seed-dup 行（url 带 #seed-dup-2 尾巴）→ url_raw 不被烤入尾巴', async () => {
    // 模拟 seed-dup 形态（见 scripts/seed.mjs 裁定 b）：url 为去重键（含后缀），url_raw 为真实地址。
    // 修复前：重分析经 analyzeAndUpsert({url: orig.url}) 把 url_raw 覆盖成含尾巴的规范化键，下次发布导出脏值。
    const created = (await getJson(await post('/api/admin/sites', { url: 'https://seeddup.invalid' }))).site;
    await dev.fetch(`/api/admin/sites/${created.id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ url: 'https://seeddup.invalid#seed-dup-2' }) });
    await dev.fetch(`/api/admin/sites/${created.id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ url_raw: 'https://seeddup.invalid/' }) });
    const res = await post(`/api/admin/sites/${created.id}/analyze`, {});
    expect(res.status).toBe(200);
    const { site } = await getJson(res);
    expect(site.url).toContain('#seed-dup-2'); // 去重键保持含尾巴（唯一性不受影响）
    expect(site.url_raw).toBe('https://seeddup.invalid/'); // 展示与导出源保真，不含尾巴
    await dev.fetch(`/api/admin/sites/${site.id}`, { method: 'DELETE', headers: auth }); // 清理
  });
  it('POST :id/analyze 不存在 id → 404', async () => {
    expect((await post('/api/admin/sites/888888/analyze', {})).status).toBe(404);
  });
});

describe('冒烟修复：PATCH 形态归一（Task 7 R4：孤儿清理已退场，行保留+siteCount 可见）', () => {
  it('PATCH：flat 分类塞垃圾 term → 置空；嵌套分类空 term → 未分组（垃圾桶子分类，预期行为）', async () => {
    const flat = (await getJson(await post('/api/admin/sites', { url: 'https://pnflat.test', title: '平', taxonomy: 'PNFLAT' }))).site;
    const nest = (await getJson(await post('/api/admin/sites', { url: 'https://pnnest.test', title: '嵌', taxonomy: 'PNNEST', term: '子甲' }))).site;
    const p1 = await dev.fetch(`/api/admin/sites/${flat.id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ term: '垃圾111' }) });
    expect(p1.status).toBe(200);
    expect((await getJson(p1)).site.term).toBe('');
    const p2 = await dev.fetch(`/api/admin/sites/${nest.id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ term: '' }) });
    expect(p2.status).toBe(200);
    expect((await getJson(p2)).site.term).toBe('未分组');
  });
  it('PATCH 跨分类移动：final pair 一并归一（嵌套旧 term 遇 flat 目标 → 置空）', async () => {
    const s = (await getJson(await post('/api/admin/sites', { url: 'https://pncross.test', title: '跨', taxonomy: 'PNNEST2', term: '子甲' }))).site;
    const p = await dev.fetch(`/api/admin/sites/${s.id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ taxonomy: 'PNFLAT' }) });
    expect(p.status).toBe(200);
    expect((await getJson(p)).site).toMatchObject({ taxonomy: 'PNFLAT', term: '' });
  });
  it('prune 退场（R4）：admin DELETE 删掉 pair 最后一行站点 → categories 行仍在且 siteCount=0；空壳同样保留', async () => {
    const s = (await getJson(await post('/api/admin/sites', { url: 'https://orphan.test', title: '孤', taxonomy: '孤儿测试', term: '子孤' }))).site;
    const cats = (await getJson(await dev.fetch('/api/admin/categories', { headers: auth }))).categories;
    expect(cats).toContainEqual({ taxonomy: '孤儿测试', term: '子孤', icon: 'fas fa-folder-open fa-lg', sort: 0, siteCount: 1 });
    const shell = await post('/api/admin/categories', { taxonomy: '空壳类' }); // 未知分类放行造空壳（Task 7：204→201 {category}）
    expect(shell.status).toBe(201);
    expect((await getJson(shell)).category).toMatchObject({ taxonomy: '空壳类', term: '' });
    await dev.fetch(`/api/admin/sites/${s.id}`, { method: 'DELETE', headers: auth });
    const after = (await getJson(await dev.fetch('/api/admin/categories', { headers: auth }))).categories;
    const row = after.find((c: any) => c.taxonomy === '孤儿测试' && c.term === '子孤');
    expect(row).toBeDefined(); // 旧断言「行消失」反转：R4 后站点删除不再连带删分类行
    expect(row.siteCount).toBe(0);
    expect(after.some((c: any) => c.taxonomy === '空壳类')).toBe(true); // 空壳由分类管理页显式删除
  });
  it('POST categories 形态守卫：flat 造嵌套行 → 400；嵌套补空 term → 400；新子分类/未知分类放行（201）', async () => {
    expect((await post('/api/admin/categories', { taxonomy: 'PNFLAT', term: '新子' })).status).toBe(400);
    expect((await post('/api/admin/categories', { taxonomy: 'PNNEST', term: '' })).status).toBe(400);
    expect((await post('/api/admin/categories', { taxonomy: 'PNNEST', term: '子乙' })).status).toBe(201);
    expect((await post('/api/admin/categories', { taxonomy: '全新分类999', term: '自带子' })).status).toBe(201);
  });
  it('prune 退场（R4）：reanalyze 成功终点不再清孤儿——原 pair 行仍在', async () => {
    const s = (await getJson(await post('/api/admin/sites', { url: 'https://reorph.test', title: '重', taxonomy: '重分析孤测', term: '子R' }))).site;
    const res = await post(`/api/admin/sites/${s.id}/analyze`, {});
    expect(res.status).toBe(200);
    const { site } = await getJson(res); // .test 不可达 → 降级 未分类；原 pair (重分析孤测,子R) 成孤儿
    const cats = (await getJson(await dev.fetch('/api/admin/categories', { headers: auth }))).categories;
    expect(cats.some((c: any) => c.taxonomy === '重分析孤测')).toBe(true); // 旧断言 false 反转（R4）
    await dev.fetch(`/api/admin/sites/${site.id}`, { method: 'DELETE', headers: auth }); // 清理
  }, 60_000);
});

describe('/api/admin/import', () => {
  it('书签 fixture：计数 {added:9,skipped_dup:1,failed:1} 与 items 形状', async () => {
    const res = await post('/api/admin/import', { html: fixtureHtml });
    expect(res.status).toBe(200);
    const r = await getJson(res);
    expect(r).toMatchObject({ added: 9, skipped_dup: 1, failed: 1 });
    expect(r.items.length).toBe(11);
    for (const it of r.items) {
      expect(it).toMatchObject({ url: expect.any(String), status: expect.any(String) });
      expect(['added', 'skipped_dup', 'failed']).toContain(it.status);
    }
    const dupItems = r.items.filter((i: { url: string }) => i.url.startsWith('https://dup.invalid/'));
    expect(dupItems.map((i: { status: string }) => i.status).sort()).toEqual(['added', 'skipped_dup']);
    const bad = r.items.find((i: { url: string }) => i.url === 'javascript:alert(1)');
    expect(bad).toMatchObject({ status: 'failed', reason: 'bad_request' });
  }, 120_000);
  it('html 超 10MB → too_large 413；~2.5MB 重复书签可通过（体积按解码后 html UTF-8 字节计）', async () => {
    const big = await post('/api/admin/import', { html: 'x'.repeat(10 * 1024 * 1024 + 10) });
    expect(big.status).toBe(413);
    expect(await getJson(big)).toMatchObject({ error: 'too_large' });
    // 100KB 级 A 标签块重复 25 次 ≈ 2.5MB html：远超旧 1MB 闸、低于 10MB 上限 → 结构上应成功；
    // 全部同 URL → 仅首条走抓取入库，其余 D1 判重即返回；条目数刻意保持小，避免 dev isolate 内存/CPU 连带污染后续请求
    const block = `<DT><A HREF="https://sizegate.invalid/" ADD_DATE="1600000000">` + 't'.repeat(100 * 1024) + `</A>\n`;
    const html = '<DL><p>\n' + block.repeat(25) + '</DL>\n';
    expect(new TextEncoder().encode(html).length).toBeGreaterThan(2 * 1024 * 1024);
    const mid = await post('/api/admin/import', { html });
    expect(mid.status).toBe(200);
    const r = await getJson(mid);
    expect(r.items.length).toBe(25);
    expect(r).toMatchObject({ added: 1, skipped_dup: 24, failed: 0 });
    expect((await post('/api/admin/import', {})).status).toBe(400);
    expect((await dev.fetch('/api/admin/import', { method: 'POST', headers: authJson, body: '{not json' })).status).toBe(400);
  }, 120_000);
  it('书签标题参与导入：目标 .invalid 抓取必失败 → 降级行 title = 书签标题而非 host', async () => {
    // 修复前 handleImport 只传 {url,source}，parser 产出的 bm.title 被丢弃，降级行标题退化为 host。
    // title 单独给出不触发直通跳过（跳过需 title+taxonomy 同非空，见 src/pipeline.ts:93 语义），仍抓取+AI、仅字段覆盖。
    const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n<DT><H3>账户</H3>\n<DL><p>\n<DT><A HREF="https://bmtitle.invalid/" ADD_DATE="1600000000">我的书签标题</A>\n</DL><p>\n</DL><p>';
    const res = await post('/api/admin/import', { html });
    expect(res.status).toBe(200);
    expect(await getJson(res)).toMatchObject({ added: 1, skipped_dup: 0, failed: 0 });
    const list = await getJson(await dev.fetch('/api/admin/sites?q=bmtitle', { headers: auth }));
    expect(list.total).toBe(1);
    expect(list.sites[0]).toMatchObject({ title: '我的书签标题', url: 'https://bmtitle.invalid', url_raw: 'https://bmtitle.invalid/', status: 'pending', source: 'import' });
    await dev.fetch(`/api/admin/sites/${list.sites[0].id}`, { method: 'DELETE', headers: auth }); // 清理
  }, 120_000);
});

describe('/api/admin/categories', () => {
  it('POST 补位 → GET 可见（缺 icon 走规则表=默认）；非法 icon 400；缺 taxonomy → 400；DELETE 按 (taxonomy,term)', async () => {
    const created = await post('/api/admin/categories', { taxonomy: 'CT', term: 'ct1' });
    expect(created.status).toBe(201); // Task 7：204 → 201 {category}
    expect((await getJson(created)).category).toMatchObject({ taxonomy: 'CT', term: 'ct1', icon: 'fas fa-folder-open fa-lg', sort: 0 });
    // Task 7：显式 icon 过 FA_CLASS 闸——非类名字符串不再被补位语义静默忽略，直接 400
    expect((await post('/api/admin/categories', { taxonomy: 'CT', term: 'ct1', icon: 'should-ignore' })).status).toBe(400);
    const cats = (await getJson(await dev.fetch('/api/admin/categories', { headers: auth }))).categories;
    expect(cats).toContainEqual({ taxonomy: 'CT', term: 'ct1', icon: 'fas fa-folder-open fa-lg', sort: 0, siteCount: 0 });
    expect((await post('/api/admin/categories', { term: 'x' })).status).toBe(400);
    expect((await dev.fetch('/api/admin/categories?taxonomy=CT&term=ct1', { method: 'DELETE', headers: auth })).status).toBe(204);
    const after = (await getJson(await dev.fetch('/api/admin/categories', { headers: auth }))).categories;
    expect(after.some((c: { taxonomy: string }) => c.taxonomy === 'CT')).toBe(false);
  });
  it('冒烟修复：GET 返回 shapes（union 形态视图，数据源同 resolve；categories 字段向后兼容）', async () => {
    // 借用前序用例沉淀的真实形态：PNFLAT=flat（两源均 ''行）、PNNEST=嵌套。
    // Task 7（R4）：孤儿不再被 prune——categories 侧 子甲/子乙 行沉淀在表内，union 取证一并可见。
    const body = await getJson(await dev.fetch('/api/admin/categories', { headers: auth }));
    expect(Array.isArray(body.categories)).toBe(true); // 原字段不动（向后兼容，行新增 siteCount 键）
    const shapes = body.shapes;
    expect(Array.isArray(shapes)).toBe(true);
    const flat = shapes.find((s: any) => s.taxonomy === 'PNFLAT');
    expect(flat).toMatchObject({ nested: false, terms: [] });
    const nest = shapes.find((s: any) => s.taxonomy === 'PNNEST');
    expect(nest.nested).toBe(true);
    expect(nest.terms).toEqual(['子乙', '子甲', '未分组']); // categories(子甲/子乙) ∪ sites(未分组)，sort() 按码位序
    // 每个 shape 的 taxonomy 必须非空且互不重复
    expect(shapes.every((s: any) => s.taxonomy !== '')).toBe(true);
    expect(new Set(shapes.map((s: any) => s.taxonomy)).size).toBe(shapes.length);
  });
});

describe('publish 路由与未知路径', () => {
  it('/api/admin/zzz → 404', async () => {
    const res = await dev.fetch('/api/admin/zzz', { headers: auth });
    expect(res.status).toBe(404);
  });
  it('POST /api/admin/publish 无管理令牌 → 401 unauthorized（鉴权在 index 层，先于 doPublish）', async () => {
    const res = await dev.fetch('/api/admin/publish', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(await getJson(res)).toMatchObject({ error: 'unauthorized' });
  });
  it('POST /api/admin/publish 有令牌但 Worker env 无 GITHUB_TOKEN → 502 jsonError 信封（配置护栏，不发起真实 GitHub 请求）', async () => {
    const res = await post('/api/admin/publish', {});
    expect(res.status).toBe(502);
    const body = await getJson(res); // 单次读取：Response body 不可消费两遍
    expect(body).toMatchObject({ error: 'fetch_failed' });
    expect(typeof body.message).toBe('string');
  });
  it('GET /api/admin/publish → 404（仅 POST）', async () => {
    expect((await dev.fetch('/api/admin/publish', { headers: auth })).status).toBe(404);
  });
});

// ── Task 4：/api/admin/friendlinks（spec-27 §3.1）──
describe('/api/admin/friendlinks', () => {
  it('POST → 201 {friendlink 含 id}；GET 列出（按 sort,id）；PATCH 改 title 生效；DELETE 204；缺行 404', async () => {
    const a = (await getJson(await post('/api/admin/friendlinks', { title: 'A 站', url: 'https://fla.test', description: '甲', sort: 2 }))).friendlink;
    expect(a).toMatchObject({ id: expect.any(Number), title: 'A 站', url: 'https://fla.test', description: '甲', sort: 2 });
    expect(typeof a.created_at).toBe('string');
    const b = (await getJson(await post('/api/admin/friendlinks', { title: 'B 站', url: 'https://flb.test', sort: 1 }))).friendlink;
    // 全表恰为这两行（测试库经 schema.sql 初始化，friendlinks 无 seed 数据）
    const list = (await getJson(await dev.fetch('/api/admin/friendlinks', { headers: auth }))).friendlinks;
    expect(list.map((f: any) => f.id)).toEqual([b.id, a.id]); // sort 升序：1 在 2 前
    // PATCH 白名单内改 title 生效，其余字段不动
    const patched = await dev.fetch(`/api/admin/friendlinks/${a.id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ title: 'A 改' }) });
    expect(patched.status).toBe(200);
    expect((await getJson(patched)).friendlink).toMatchObject({ id: a.id, title: 'A 改', url: 'https://fla.test', description: '甲', sort: 2 });
    // PATCH 校验：白名单外键（空补丁）400、title 非字符串 400、sort 非数字 400
    expect((await dev.fetch(`/api/admin/friendlinks/${a.id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ zz: 1 }) })).status).toBe(400);
    expect((await dev.fetch(`/api/admin/friendlinks/${a.id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ title: ' ' }) })).status).toBe(400);
    expect((await dev.fetch(`/api/admin/friendlinks/${a.id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ sort: '2' }) })).status).toBe(400);
    // DELETE → 204 且行消失
    expect((await dev.fetch(`/api/admin/friendlinks/${b.id}`, { method: 'DELETE', headers: auth })).status).toBe(204);
    const after = (await getJson(await dev.fetch('/api/admin/friendlinks', { headers: auth }))).friendlinks;
    expect(after.map((f: any) => f.id)).toEqual([a.id]);
    // 缺行：PATCH 不存在 id → 404 {error:bad_request}（信封口径同 sites）；DELETE 幂等仍 204
    const missing = await dev.fetch('/api/admin/friendlinks/999999', { method: 'PATCH', headers: authJson, body: JSON.stringify({ title: 'x' }) });
    expect(missing.status).toBe(404);
    expect(await getJson(missing)).toMatchObject({ error: 'bad_request' });
    expect((await dev.fetch('/api/admin/friendlinks/999999', { method: 'DELETE', headers: auth })).status).toBe(204);
    // Task 5 结转修复：/:id 块补「方法不支持」兜底（对齐 sites 段原文案）——GET/PUT 不再漏到路由尾部 404
    expect((await dev.fetch('/api/admin/friendlinks/999999', { headers: auth })).status).toBe(400);
    expect((await dev.fetch('/api/admin/friendlinks/999999', { method: 'PUT', headers: authJson, body: '{}' })).status).toBe(400);
    await dev.fetch(`/api/admin/friendlinks/${a.id}`, { method: 'DELETE', headers: auth }); // 清理，表回到空
  });
  it('POST 校验：title/url 非空否则 400；url 不做 normalizeUrl（"/relative" 原样存）', async () => {
    expect((await post('/api/admin/friendlinks', { url: 'https://flx.test' })).status).toBe(400); // 缺 title
    expect((await post('/api/admin/friendlinks', { title: '  ', url: 'https://flx.test' })).status).toBe(400); // title 全空格
    expect((await post('/api/admin/friendlinks', { title: '缺 url' })).status).toBe(400); // 缺 url
    expect((await post('/api/admin/friendlinks', { title: '空 url', url: '  ' })).status).toBe(400); // url 全空格
    expect((await post('/api/admin/friendlinks', { title: 123, url: 'https://flx.test' })).status).toBe(400); // title 非字符串
    const res = await post('/api/admin/friendlinks', { title: '相对', url: '/relative' });
    expect(res.status).toBe(201);
    const { friendlink } = await getJson(res);
    expect(friendlink.url).toBe('/relative'); // 字节保真：不规范化、不补协议
    expect(friendlink.description).toBe(''); // 可选字段缺省 ''
    expect(friendlink.sort).toBe(0); // 可选字段缺省 0
    await dev.fetch(`/api/admin/friendlinks/${friendlink.id}`, { method: 'DELETE', headers: auth }); // 清理
  });
  it('batch-delete {ids} → {deleted:n}；ids 含非正整数 → 400；空数组 → 400', async () => {
    const ids: number[] = [];
    for (const t of ['x', 'y', 'z']) {
      ids.push((await getJson(await post('/api/admin/friendlinks', { title: `批量${t}`, url: `https://flbd-${t}.test` }))).friendlink.id);
    }
    const res = await post('/api/admin/friendlinks/batch-delete', { ids: ids.slice(0, 2) });
    expect(res.status).toBe(200);
    expect(await getJson(res)).toEqual({ deleted: 2 });
    const left = (await getJson(await dev.fetch('/api/admin/friendlinks', { headers: auth }))).friendlinks;
    expect(left.map((f: any) => f.id)).toEqual([ids[2]]); // 字面量段先于 /:id 正则：POST batch-delete 不被当成 id
    expect((await post('/api/admin/friendlinks/batch-delete', { ids: [0] })).status).toBe(400); // 非正
    expect((await post('/api/admin/friendlinks/batch-delete', { ids: [-1] })).status).toBe(400);
    expect((await post('/api/admin/friendlinks/batch-delete', { ids: [1.5] })).status).toBe(400); // 非整数
    expect((await post('/api/admin/friendlinks/batch-delete', { ids: [] })).status).toBe(400); // 空数组
    expect((await post('/api/admin/friendlinks/batch-delete', {})).status).toBe(400); // 缺 ids
    const one = await post('/api/admin/friendlinks/batch-delete', { ids: [ids[2]] });
    expect(await getJson(one)).toEqual({ deleted: 1 });
  });
});

// ── Task 5：/api/admin/navitems（spec-27 §3.2）：一层下拉限制 + 原子批删 ──
describe('/api/admin/navitems', () => {
  const navList = async () => ((await getJson(await dev.fetch('/api/admin/navitems', { headers: auth }))).navitems) as any[];
  const mk = async (body: Record<string, unknown>) => {
    const res = await post('/api/admin/navitems', body);
    expect(res.status).toBe(201);
    return (await getJson(res)).navitem;
  };
  const navPatch = (id: number, body: unknown) =>
    dev.fetch(`/api/admin/navitems/${id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify(body) });
  const navDelete = (id: number) => dev.fetch(`/api/admin/navitems/${id}`, { method: 'DELETE', headers: auth });

  it('行为1：POST 顶层 → 201 {navitem}，parent_id null，icon/link/sort 缺省为空/0', async () => {
    const res = await post('/api/admin/navitems', { item: '首页', icon: 'fa fa-home', link: './' });
    expect(res.status).toBe(201);
    const n = (await getJson(res)).navitem;
    expect(n).toMatchObject({ id: expect.any(Number), item: '首页', icon: 'fa fa-home', link: './', sort: 0 });
    expect(n.parent_id).toBe(null);
    expect(typeof n.created_at).toBe('string');
    const bare = await mk({ item: '裸顶层' });
    expect(bare).toMatchObject({ icon: '', link: '', sort: 0 });
    expect(bare.parent_id).toBe(null);
    await navDelete(n.id);
    await navDelete(bare.id);
  });

  it('行为2：POST 子项 → 201；GET 序=顶层按 (sort,id)，子项紧跟父并按 (sort,id)（路由层后处理裁定）', async () => {
    const t2 = await mk({ item: 'T2', sort: 2 });
    const t1 = await mk({ item: 'T1', sort: 1 });
    const cA = await mk({ item: 'Emoji', link: './assets/emoji/', parent_id: t1.id, sort: 5 });
    const cB = await mk({ item: 'B', link: './b/', parent_id: t1.id, sort: 1 });
    const cC = await mk({ item: 'C', parent_id: t2.id });
    const ids = new Set<number>([t1.id, t2.id, cA.id, cB.id, cC.id]);
    const seq = (await navList()).filter((r) => ids.has(r.id)).map((r) => r.id);
    expect(seq).toEqual([t1.id, cB.id, cA.id, t2.id, cC.id]); // 顶层 sort 1<2；t1 两子按 sort 1<5 紧跟其后
    for (const id of [cA.id, cB.id, cC.id, t1.id, t2.id]) await navDelete(id);
  });

  it('行为3：POST parent_id 指向子项/不存在/非法类型 → 400（一层封死）；坏 JSON → 400', async () => {
    const p = await mk({ item: '父3' });
    const c = await mk({ item: '子3', parent_id: p.id });
    const bad1 = await post('/api/admin/navitems', { item: '孙', parent_id: c.id });
    expect(bad1.status).toBe(400);
    expect((await getJson(bad1)).message).toContain('一层');
    const bad2 = await post('/api/admin/navitems', { item: '挂不存在的', parent_id: 999999 });
    expect(bad2.status).toBe(400);
    expect((await getJson(bad2)).message).toContain('不存在');
    expect((await post('/api/admin/navitems', { item: '类型错', parent_id: '3' })).status).toBe(400); // 字符串 id
    expect((await post('/api/admin/navitems', { item: '非正', parent_id: 0 })).status).toBe(400);
    expect((await dev.fetch('/api/admin/navitems', { method: 'POST', headers: authJson, body: '{nope' })).status).toBe(400); // 坏 JSON → readJsonBody null
    await navDelete(c.id);
    await navDelete(p.id);
  });

  it('行为4：PATCH 成环/破层/升顶闸（父挂向自身→400；null 且行有子→400 请删除子项后再升顶；有子顶层降挂→400）', async () => {
    const p = await mk({ item: '父4' });
    const c = await mk({ item: '子4', parent_id: p.id });
    const r1 = await navPatch(p.id, { parent_id: c.id }); // 父项挂到自己子项下 = 环 + 三层
    expect(r1.status).toBe(400);
    expect((await getJson(r1)).message).toContain('一层');
    const r2 = await navPatch(p.id, { parent_id: p.id });
    expect(r2.status).toBe(400);
    expect((await getJson(r2)).message).toContain('自身');
    const r3 = await navPatch(p.id, { parent_id: null }); // 行有子：null 挂载被闸（控制器裁定闸）
    expect(r3.status).toBe(400);
    expect((await getJson(r3)).message).toContain('请删除子项后再升顶');
    const q = await mk({ item: '空父4' });
    const r4 = await navPatch(p.id, { parent_id: q.id }); // 自身有子降挂 → handler 自侧闸拦（裁决1 后一层不变式的降挂守卫）
    expect(r4.status).toBe(400);
    expect((await getJson(r4)).message).toContain('子项');
    const r5 = await navPatch(c.id, { parent_id: q.id }); // 无子子项改挂空顶层 → 放行
    expect(r5.status).toBe(200);
    expect((await getJson(r5)).navitem).toMatchObject({ id: c.id, parent_id: q.id });
    const r6 = await navPatch(c.id, { parent_id: p.id }); // p 之子已迁走 → 挂回放行
    expect(r6.status).toBe(200);
    const q2 = await mk({ item: '有子父4' });
    const d = await mk({ item: '子4d', parent_id: q2.id });
    // 审查裁决1：目标侧「该顶层项已有子项」分支删除——挂到已有子的顶层是合法操作（一层不变式由自侧闸+父须顶层闸封死）
    const r7 = await navPatch(c.id, { parent_id: q2.id });
    expect(r7.status).toBe(200);
    expect((await getJson(r7)).navitem).toMatchObject({ id: c.id, parent_id: q2.id });
    const missing = await navPatch(999999, { item: 'x' });
    expect(missing.status).toBe(404);
    expect(await getJson(missing)).toMatchObject({ error: 'bad_request' });
    // GET 分组：q2 两子 (d,c) 按 (sort,id) 紧跟其后；p/q 已无子
    const own = new Set<number>([p.id, q.id, q2.id, c.id, d.id]);
    expect((await navList()).filter((r) => own.has(r.id)).map((r) => r.id)).toEqual([p.id, q.id, q2.id, c.id, d.id]);
    for (const id of [c.id, d.id, p.id, q.id, q2.id]) await navDelete(id);
  });

  it('行为4b（裁决2）：PATCH parent_id:null 三形态——无子顶层 no-op 放行；有子顶层仍 400；无子子项真升顶放行', async () => {
    const t = await mk({ item: '无子顶4b' });
    const rNoopTop = await navPatch(t.id, { parent_id: null }); // ① 无子顶层 no-op → 200 原样
    expect(rNoopTop.status).toBe(200);
    expect((await getJson(rNoopTop)).navitem).toMatchObject({ id: t.id, parent_id: null, item: '无子顶4b' });
    const c = await mk({ item: '子4b', parent_id: t.id });
    const rTopWithKids = await navPatch(t.id, { parent_id: null }); // ② 有子顶层 → 升顶闸仍 400（r3 同型，此处固化）
    expect(rTopWithKids.status).toBe(400);
    expect((await getJson(rTopWithKids)).message).toContain('请删除子项后再升顶');
    const rPromote = await navPatch(c.id, { parent_id: null }); // ③ 无子子项真升顶 → 200（一层不变式下子行必无子，闸不误伤）
    expect(rPromote.status).toBe(200);
    expect((await getJson(rPromote)).navitem).toMatchObject({ id: c.id, parent_id: null });
    const own = new Set<number>([t.id, c.id]);
    expect((await navList()).filter((r) => own.has(r.id)).map((r) => r.id)).toEqual([t.id, c.id]); // 两顶层并列 (sort,id)
    await navDelete(c.id);
    await navDelete(t.id);
  });

  it('行为5：DELETE 有子顶层 → 400（message 含「子项」）；先删子再删父 → 204/204；DELETE 幂等；/:id GET → 400 方法不支持', async () => {
    const p = await mk({ item: '父5' });
    const c = await mk({ item: '子5', parent_id: p.id });
    const bad = await navDelete(p.id);
    expect(bad.status).toBe(400);
    expect((await getJson(bad)).message).toContain('子项');
    expect((await navDelete(c.id)).status).toBe(204);
    expect((await navDelete(p.id)).status).toBe(204);
    expect((await navDelete(999999)).status).toBe(204); // 幂等（同 friendlinks/sites 口径）
    expect((await dev.fetch('/api/admin/navitems/999999', { headers: auth })).status).toBe(400);
  });

  it('行为6：batch-delete 原子——{父}未含全部子 → 400 整体拒（GET 行数不变）；{父+全部子} → 200 deleted 全数', async () => {
    const p = await mk({ item: '父6' });
    const c1 = await mk({ item: '子6a', parent_id: p.id });
    const c2 = await mk({ item: '子6b', parent_id: p.id });
    const other = await mk({ item: '无关6' });
    const before = (await navList()).length;
    const reject1 = await post('/api/admin/navitems/batch-delete', { ids: [p.id] });
    expect(reject1.status).toBe(400);
    expect((await getJson(reject1)).message).toContain('子项');
    expect((await post('/api/admin/navitems/batch-delete', { ids: [p.id, c1.id] })).status).toBe(400); // c2 仍未勾
    expect((await navList()).length).toBe(before); // 原子性：零删除
    const ok = await post('/api/admin/navitems/batch-delete', { ids: [p.id, c1.id, c2.id] });
    expect(ok.status).toBe(200);
    expect(await getJson(ok)).toEqual({ deleted: 3 });
    expect((await navList()).length).toBe(before - 3);
    expect((await post('/api/admin/navitems/batch-delete', { ids: [] })).status).toBe(400);
    expect((await post('/api/admin/navitems/batch-delete', { ids: [0] })).status).toBe(400);
    expect((await post('/api/admin/navitems/batch-delete', { ids: [1.5] })).status).toBe(400);
    expect((await post('/api/admin/navitems/batch-delete', {})).status).toBe(400);
    expect((await post('/api/admin/navitems/batch-delete', { ids: [other.id] })).status).toBe(200); // 字面量段先于 /:id：POST 不被当 id
  });

  it('行为7：POST/PATCH item 非空校验；link/icon 允许空串（纯下拉容器）；白名单外键 400；PATCH 生效回 200', async () => {
    expect((await post('/api/admin/navitems', {})).status).toBe(400);
    expect((await post('/api/admin/navitems', { item: '  ' })).status).toBe(400);
    const box = await mk({ item: '纯下拉', link: '', icon: '' });
    expect(box.link).toBe('');
    expect((await navPatch(box.id, { item: '  ' })).status).toBe(400);
    expect((await navPatch(box.id, { item: 5 })).status).toBe(400);
    expect((await navPatch(box.id, { zz: 1 })).status).toBe(400); // 白名单外 → 无可更新字段
    expect((await navPatch(box.id, { sort: '7' })).status).toBe(400); // sort 非数字
    const r = await navPatch(box.id, { link: './new/', sort: 7 });
    expect(r.status).toBe(200);
    expect((await getJson(r)).navitem).toMatchObject({ id: box.id, link: './new/', sort: 7, item: '纯下拉', parent_id: null });
    await navDelete(box.id);
    expect(await navList()).toEqual([]); // 收尾：本 describe 数据自清理，表回到空
  });
});

// ── Task 7：/api/admin/categories 一等公民进化（spec-27 §3.3/§5.3 + R4）：siteCount/改名级联/非空禁删/原子批删 ──
describe('categories 管理（Task 7）', () => {
  const catRow = async (taxonomy: string, term: string) =>
    ((await getJson(await dev.fetch('/api/admin/categories', { headers: auth }))).categories as any[])
      .find((c) => c.taxonomy === taxonomy && c.term === term);
  const patchCat = (body: unknown) =>
    dev.fetch('/api/admin/categories', { method: 'PATCH', headers: authJson, body: JSON.stringify(body) });
  const deleteCat = (taxonomy: string, term = '') =>
    dev.fetch(`/api/admin/categories?taxonomy=${encodeURIComponent(taxonomy)}&term=${encodeURIComponent(term)}`, { method: 'DELETE', headers: auth });
  // 直通造数（title+taxonomy 同给零网络）：pipeline 顺带补 categories 行
  const mk = async (url: string, taxonomy: string, term?: string) =>
    (await getJson(await post('/api/admin/sites', { url, title: 'T', taxonomy, ...(term ? { term } : {}) }))).site as { id: number };

  it('GET：每行附 siteCount（pair 精确计数，任意 status——pending 也计入）；shapes 原样在', async () => {
    await mk('https://c7count-a.test', 'C7数类', '子一');
    await mk('https://c7count-b.test', 'C7数类', '子一');
    await mk('https://c7count-c.test', 'C7数类', '子二'); // 同 taxonomy 不同 pair 各自计数
    expect((await catRow('C7数类', '子一')).siteCount).toBe(2);
    expect((await catRow('C7数类', '子二')).siteCount).toBe(1);
    const body = await getJson(await dev.fetch('/api/admin/categories', { headers: auth }));
    expect(Array.isArray(body.shapes)).toBe(true); // 原字段不动（向后兼容）
    expect(body.shapes.some((s: any) => s.taxonomy === 'C7数类' && s.nested && s.terms.includes('子一'))).toBe(true);
  });

  it('POST：显式 icon 合法 → 201 回显 icon/sort；缺 icon 且无 AI 配置 → 规则表（游戏→fa-gamepad，零网络）；非法 icon → 400 零写入', async () => {
    const withIcon = await post('/api/admin/categories', { taxonomy: 'C7指定', term: '子a', icon: 'fas fa-wrench fa-lg', sort: 9 });
    expect(withIcon.status).toBe(201);
    expect((await getJson(withIcon)).category).toMatchObject({ taxonomy: 'C7指定', term: '子a', icon: 'fas fa-wrench fa-lg', sort: 9 });
    const auto = await post('/api/admin/categories', { taxonomy: 'C7游戏' }); // wrangler vars 无 AI_* → resolveIcon 落规则表（直通零网络纪律）
    expect(auto.status).toBe(201);
    expect((await getJson(auto)).category).toMatchObject({ taxonomy: 'C7游戏', term: '', icon: 'fas fa-gamepad', sort: 0 });
    const bad = await post('/api/admin/categories', { taxonomy: 'C7坏图标', icon: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);
    expect(await getJson(bad)).toMatchObject({ error: 'bad_request' });
    expect(await catRow('C7坏图标', '')).toBeUndefined(); // 拒绝路径零落库
    // 补位语义保留：已存在 pair 上送合法 icon 也不覆盖（人工管理优先），响应回显既有行
    const again = await post('/api/admin/categories', { taxonomy: 'C7指定', term: '子a', icon: 'fas fa-star' });
    expect(again.status).toBe(201);
    expect((await getJson(again)).category).toMatchObject({ icon: 'fas fa-wrench fa-lg', sort: 9 });
  });

  it('PATCH 改 taxonomy：header 整类级联（categories header+子行、sites 全改）；目标撞名（union 已有）→ 400 不隐式合并；只改 icon/sort → 仅动 categories；源行缺 → 404', async () => {
    const s = await mk('https://c7ren.test', 'C7旧类', '子一'); // pipeline 补行 (C7旧类,子一)
    await post('/api/admin/categories', { taxonomy: 'C7旧类', term: '子二' }); // 嵌套形态放行加子行
    const toHeader = await patchCat({ taxonomy: 'C7旧类', term: '子二', new: { term: '' } }); // 子二升格为 header 行
    expect(toHeader.status).toBe(200);
    expect((await getJson(toHeader)).category).toMatchObject({ taxonomy: 'C7旧类', term: '' });
    const r = await patchCat({ taxonomy: 'C7旧类', term: '', new: { taxonomy: 'C7新类' } });
    expect(r.status).toBe(200);
    expect((await getJson(r)).category).toMatchObject({ taxonomy: 'C7新类', term: '' });
    expect(await catRow('C7旧类', '')).toBeUndefined();
    expect(await catRow('C7旧类', '子一')).toBeUndefined();
    expect((await catRow('C7新类', '子一')).siteCount).toBe(1); // 子行连带改名且站点计数跟随
    const sites = await getJson(await dev.fetch(`/api/admin/sites?taxonomy=${encodeURIComponent('C7新类')}`, { headers: auth }));
    expect(sites.total).toBe(1);
    expect(sites.sites[0].id).toBe(s.id); // 同一站点行被 UPDATE 跟随（非删重插）
    // 目标撞名：C7衝突 在 union 已有行 → 整类改名 400（不提供隐式合并）
    await post('/api/admin/categories', { taxonomy: 'C7衝突' });
    const collide = await patchCat({ taxonomy: 'C7新类', term: '', new: { taxonomy: 'C7衝突' } });
    expect(collide.status).toBe(400);
    expect((await getJson(collide)).message).toContain('C7衝突');
    expect(await catRow('C7新类', '子一')).toBeDefined(); // 拒绝零写入
    // 只改 icon/sort：仅动目标 categories 行
    const before = JSON.stringify(await getJson(await dev.fetch(`/api/admin/sites?taxonomy=${encodeURIComponent('C7新类')}`, { headers: auth })));
    const only = await patchCat({ taxonomy: 'C7新类', term: '子一', new: { icon: 'fas fa-book-open', sort: 4 } });
    expect(only.status).toBe(200);
    expect((await getJson(only)).category).toMatchObject({ taxonomy: 'C7新类', term: '子一', icon: 'fas fa-book-open', sort: 4 });
    expect((await catRow('C7新类', '')).icon).not.toBe('fas fa-book-open'); // header 行未被连带
    expect(JSON.stringify(await getJson(await dev.fetch(`/api/admin/sites?taxonomy=${encodeURIComponent('C7新类')}`, { headers: auth })))).toBe(before);
    // 非法 icon 400；源行不存在 404；缺 taxonomy 400
    expect((await patchCat({ taxonomy: 'C7新类', term: '', new: { icon: 'run(evil)' } })).status).toBe(400);
    expect((await patchCat({ taxonomy: 'C7新类', term: '', new: { taxonomy: '  ' } })).status).toBe(400); // 空目标名不得落库（毒化 shapes）
    const nf = await patchCat({ taxonomy: 'C7无此', term: '', new: { icon: 'fas fa-star' } });
    expect(nf.status).toBe(404);
    expect(await getJson(nf)).toMatchObject({ error: 'bad_request' });
    expect((await patchCat({ term: '', new: {} })).status).toBe(400);
  });

  it('PATCH 改 term：(tax,子甲)→子乙 连带 sites 跟随；目标 (tax,子乙) 已存在 → 400', async () => {
    await mk('https://c7term.test', 'C7多子', '子甲');
    const r = await patchCat({ taxonomy: 'C7多子', term: '子甲', new: { term: '子乙' } });
    expect(r.status).toBe(200);
    expect((await getJson(r)).category).toMatchObject({ taxonomy: 'C7多子', term: '子乙' });
    expect(await catRow('C7多子', '子甲')).toBeUndefined();
    expect((await catRow('C7多子', '子乙')).siteCount).toBe(1); // 站点行 term 跟随
    const sites = await getJson(await dev.fetch(`/api/admin/sites?taxonomy=${encodeURIComponent('C7多子')}&term=${encodeURIComponent('子乙')}`, { headers: auth }));
    expect(sites.total).toBe(1);
    await post('/api/admin/categories', { taxonomy: 'C7多子', term: '子丙' });
    const collide = await patchCat({ taxonomy: 'C7多子', term: '子丙', new: { term: '子乙' } });
    expect(collide.status).toBe(400);
    expect((await getJson(collide)).message).toContain('子乙');
  });

  it('DELETE 守卫：非空 pair → 400（message 含条数）；空 pair term 行 → 204；header：该 taxonomy 有任意站点 → 400，零站点 → 204 且子分类行连带消失', async () => {
    await mk('https://c7del-a.test', 'C7删除', '子甲');
    await mk('https://c7del-b.test', 'C7删除', '子甲');
    const blocked = await deleteCat('C7删除', '子甲');
    expect(blocked.status).toBe(400);
    expect((await getJson(blocked)).message).toContain('2'); // 条数进 message
    expect(await catRow('C7删除', '子甲')).toBeDefined(); // 拒绝零写入
    await post('/api/admin/categories', { taxonomy: 'C7删除', term: '子乙' }); // 空 pair 行
    expect((await deleteCat('C7删除', '子乙')).status).toBe(204);
    expect(await catRow('C7删除', '子乙')).toBeUndefined();
    // header 删除（term=''）= 整类删：C7删除 仍有站点 → 400
    expect((await deleteCat('C7删除')).status).toBe(400);
    // 清空站点后整类删：仅剩空壳 子甲 行，连带消失
    const left = await getJson(await dev.fetch(`/api/admin/sites?taxonomy=${encodeURIComponent('C7删除')}`, { headers: auth }));
    for (const r of left.sites) await dev.fetch(`/api/admin/sites/${r.id}`, { method: 'DELETE', headers: auth });
    expect((await deleteCat('C7删除')).status).toBe(204);
    const cats = (await getJson(await dev.fetch('/api/admin/categories', { headers: auth }))).categories as any[];
    expect(cats.some((c) => c.taxonomy === 'C7删除')).toBe(false);
  });

  it('batch-delete 原子：任一 pair 非空 → 400 列全阻塞且零删除；全空 → 200 {deleted:n}；header 按 taxonomy 全量口径；参数校验 400', async () => {
    const s = await mk('https://c7bd-a.test', 'C7批非空', '子一');
    await post('/api/admin/categories', { taxonomy: 'C7批空', term: '子一' });
    const before = ((await getJson(await dev.fetch('/api/admin/categories', { headers: auth }))).categories as any[]).length;
    const reject = await post('/api/admin/categories/batch-delete', { pairs: [{ taxonomy: 'C7批非空', term: '子一' }, { taxonomy: 'C7批空', term: '子一' }] });
    expect(reject.status).toBe(400);
    expect((await getJson(reject)).message).toContain('C7批非空');
    expect(((await getJson(await dev.fetch('/api/admin/categories', { headers: auth }))).categories as any[]).length).toBe(before); // 零写
    await dev.fetch(`/api/admin/sites/${s.id}`, { method: 'DELETE', headers: auth }); // 掏空 → 再批删全空
    const ok = await post('/api/admin/categories/batch-delete', { pairs: [{ taxonomy: 'C7批非空', term: '子一' }, { taxonomy: 'C7批空', term: '子一' }] });
    expect(ok.status).toBe(200);
    expect(await getJson(ok)).toEqual({ deleted: 2 });
    // header pair（term=''）按 countSitesByTaxonomy 口径：taxonomy 下有站点即阻塞
    const s2 = await mk('https://c7bd-b.test', 'C7批壳'); // (C7批壳,'') 行 + 1 站点
    const hdr = await post('/api/admin/categories/batch-delete', { pairs: [{ taxonomy: 'C7批壳', term: '' }] });
    expect(hdr.status).toBe(400);
    expect((await getJson(hdr)).message).toContain('C7批壳');
    await dev.fetch(`/api/admin/sites/${s2.id}`, { method: 'DELETE', headers: auth });
    expect(await getJson(await post('/api/admin/categories/batch-delete', { pairs: [{ taxonomy: 'C7批壳' }] }))).toEqual({ deleted: 1 });
    // 参数校验
    expect((await post('/api/admin/categories/batch-delete', { pairs: [] })).status).toBe(400);
    expect((await post('/api/admin/categories/batch-delete', {})).status).toBe(400);
    expect((await post('/api/admin/categories/batch-delete', { pairs: [{ term: 'x' }] })).status).toBe(400);
    expect((await post('/api/admin/categories/batch-delete', { pairs: 'nope' })).status).toBe(400);
    expect((await dev.fetch('/api/admin/categories/batch-delete', { headers: auth })).status).toBe(400); // GET → 方法不支持兜底（Task 4 约定）
  });

  it('prune 退场（R4）：站点删除后空壳分类行可见、可显式删（一等公民闭环）', async () => {
    const s = await mk('https://c7zombie.test', 'C7残骸', '殁');
    expect((await catRow('C7残骸', '殁')).siteCount).toBe(1);
    await dev.fetch(`/api/admin/sites/${s.id}`, { method: 'DELETE', headers: auth });
    const row = await catRow('C7残骸', '殁');
    expect(row).toBeDefined();
    expect(row.siteCount).toBe(0);
    expect((await deleteCat('C7残骸', '殁')).status).toBe(204); // 空 pair 由分类管理页显式删除
  });
});

// ── Task 8：POST /api/admin/sites/batch-delete 三形态（ids/filter/wipe 互斥）──
// 三形态各删的是「路由白名单」目标；wipe 是全表删——本 describe 是最后一个依赖 dev-server sites 的用例组，
// 其后仅「reanalyze 单元级」（stub DB，不碰 dev-server），故 wipe 收尾安全。
describe('sites/batch-delete 三形态（Task 8）', () => {
  const bd = (body: unknown) => post('/api/admin/sites/batch-delete', body);
  const sitesTotal = async (): Promise<number> =>
    (await getJson(await dev.fetch('/api/admin/sites?perPage=1', { headers: auth }))).total;
  // 直通造数（title+taxonomy 同给零网络，同 Task 7 mk）
  const mk = async (url: string, taxonomy: string, title = 'T', term?: string) =>
    (await getJson(await post('/api/admin/sites', { url, title, taxonomy, ...(term ? { term } : {}) }))).site as { id: number };

  it('行为1：{ids:[a,b]} → {deleted:2} 且行消失；含不存在 id 按实删（不报错）', async () => {
    const a = (await mk('https://bd1-a.test', 'BD批删')).id;
    const b = (await mk('https://bd1-b.test', 'BD批删')).id;
    const keep = (await mk('https://bd1-keep.test', 'BD批删')).id;
    const res = await bd({ ids: [a, b] });
    expect(res.status).toBe(200);
    expect(await getJson(res)).toEqual({ deleted: 2 });
    const left = await getJson(await dev.fetch('/api/admin/sites?taxonomy=BD批删', { headers: auth }));
    expect(left.total).toBe(1);
    expect(left.sites[0].id).toBe(keep);
    // 混入不存在 id：只删实存的那一个，不报错
    const mix = await bd({ ids: [keep, 999999] });
    expect(mix.status).toBe(200);
    expect(await getJson(mix)).toEqual({ deleted: 1 });
  });

  it('行为2：{filter:{taxonomy}} 只删该分类；{filter:{q}} LIKE 同 GET 语义（含通配符转义）', async () => {
    await mk('https://bd2-jia-a.test', 'BD筛甲');
    await mk('https://bd2-jia-b.test', 'BD筛甲');
    await mk('https://bd2-yi.test', 'BD筛乙');
    const r1 = await bd({ filter: { taxonomy: 'BD筛甲' } });
    expect(r1.status).toBe(200);
    expect(await getJson(r1)).toEqual({ deleted: 2 }); // 只删该分类
    expect((await getJson(await dev.fetch('/api/admin/sites?taxonomy=BD筛甲', { headers: auth }))).total).toBe(0);
    expect((await getJson(await dev.fetch('/api/admin/sites?taxonomy=BD筛乙', { headers: auth }))).total).toBe(1); // 他类不动
    // q 语义与 GET 一致（转义同 sitesWhere）：普通关键词
    const hit = await bd({ filter: { q: 'bd2-yi' } }); // url 含 bd2-yi
    expect(hit.status).toBe(200);
    expect(await getJson(hit)).toEqual({ deleted: 1 });
    // 通配符转义：下划线当字面量——q='下_划' 只命中 title 含「下_划」的行，不误匹配「下X划」
    const x1 = (await mk('https://bd2-us.test', 'BD筛丙', '下_划线')).id;
    await mk('https://bd2-usx.test', 'BD筛丙', '下X划线');
    const before = await getJson(await dev.fetch('/api/admin/sites?q=%E4%B8%8B_%E5%88%92', { headers: auth }));
    expect(before.total).toBe(1); // GET 侧取证：转义后只 1 命中（若未转义，'下_划' 的 _ 会通配 '下X划' → 命中 2）
    expect(before.sites[0].id).toBe(x1);
    const esc = await bd({ filter: { q: '下_划' } });
    expect(esc.status).toBe(200);
    expect(await getJson(esc)).toEqual({ deleted: 1 }); // 与 GET 同口径：实删 1
    const remain = await getJson(await dev.fetch('/api/admin/sites?taxonomy=BD筛丙', { headers: auth }));
    expect(remain.total).toBe(1);
    expect(remain.sites[0].title).toBe('下X划线'); // 未被误删
  });

  it('行为3：互斥与校验——{} 400；ids+filter 同现 400；ids 非数组/0/负/小数 400；filter 空对象/白名单外键 400（绝不空 opts 清表）', async () => {
    const seed = await mk('https://bd3.test', 'BD校验');
    // 显式形态缺失 / 多形态同现 → 400，零删除
    expect((await bd({})).status).toBe(400);
    expect((await bd({ ids: [seed.id], filter: { taxonomy: 'BD校验' } })).status).toBe(400); // 两形态
    expect((await bd({ ids: [seed.id], wipe: '全部删除' })).status).toBe(400);
    // ids 非法形态
    expect((await bd({ ids: 'nope' })).status).toBe(400); // 非数组
    expect((await bd({ ids: [] })).status).toBe(400); // 空数组
    expect((await bd({ ids: [0] })).status).toBe(400);
    expect((await bd({ ids: [-1] })).status).toBe(400);
    expect((await bd({ ids: [1.5] })).status).toBe(400);
    // filter 安全闸（T1 review）：空对象 / 白名单外键 / 全空值 → 400，绝不落到全表删
    expect((await bd({ filter: {} })).status).toBe(400);
    expect((await bd({ filter: { bogus: 'x' } })).status).toBe(400);
    expect((await bd({ filter: { taxonomy: '' } })).status).toBe(400);
    expect((await bd({ filter: 'nope' })).status).toBe(400); // filter 非对象
    // 所有 400 路径零删除：seed 行仍在，且全表总数未因任一非法请求而变小
    const still = await getJson(await dev.fetch('/api/admin/sites?taxonomy=BD校验', { headers: auth }));
    expect(still.total).toBe(1);
    expect(still.sites[0].id).toBe(seed.id);
  });

  it('行为4：wipe 逐字确认——{wipe:"手滑"} 400 零删；{wipe:"全部删除"} 全表删（deleted=当前总数，随后为 0）', async () => {
    const bad = await bd({ wipe: '手滑' });
    expect(bad.status).toBe(400);
    expect((await getJson(bad)).error).toBe('bad_request');
    const before = await sitesTotal();
    expect(before).toBeGreaterThan(0); // 前序 fixture 沉淀（本用例在末位，收尾安全）
    const ok = await bd({ wipe: '全部删除' });
    expect(ok.status).toBe(200);
    expect(await getJson(ok)).toEqual({ deleted: before }); // 全库删
    expect(await sitesTotal()).toBe(0);
  });
});

// ── 单元级：reanalyze 抛异常回滚 + 顶层错误外壳 ──
// 集成环境（unstable_dev）里流水线没有自然抛异常的路径：.invalid 抓取走降级返回（ok:false）而非 throw，
// 也无法在「删除之后」注入 D1 故障——故直接调用 handleAdmin，用按 SQL 前缀分派的 D1 假件驱动该分支。

const origRow: SiteRow = {
  id: 5, url: 'https://rollback.invalid/', url_raw: 'https://rollback.invalid/',
  title: '原题', description: '', logo: '', taxonomy: 'T', term: '', status: 'published', source: 'manual', sort: 3,
  created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00',
};

const makeStubDb = (restoreConflict: boolean) => {
  const calls: string[] = [];
  const unexpected = (sql: string) => new Error('unexpected SQL in stub: ' + sql);
  const db = {
    prepare: (sql: string) => {
      // D1 语句既可 bind() 后再执行，也可直接执行（allCategories 无参 SELECT）——两种形态都要支持
      const exec = {
        first: async () => {
          if (sql.startsWith('SELECT * FROM sites WHERE id')) { calls.push('get'); return origRow; }
          if (sql.startsWith('SELECT * FROM sites WHERE url')) { calls.push('dupcheck'); return null; }
          if (sql.startsWith('INSERT INTO sites')) {
            calls.push('restore');
            if (restoreConflict) throw new Error('D1_ERROR: UNIQUE constraint failed: sites.url');
            return origRow;
          }
          throw unexpected(sql);
        },
        run: async () => {
          if (sql.startsWith('DELETE FROM sites')) { calls.push('delete'); return {}; }
          throw unexpected(sql); // Task 7（R4）：prune 退场后回滚路径不再有 'DELETE FROM categories'——若复现即 unknown SQL 炸出
        },
        all: async () => {
          if (sql.startsWith('SELECT * FROM categories')) { calls.push('boom'); throw new Error('D1_ERROR: 模拟流水线中段 D1 故障'); }
          throw unexpected(sql);
        },
      };
      return { bind: (..._vals: never[]) => exec, ...exec };
    },
  };
  return { calls, db: db as unknown as D1Database };
};

const stubEnv = (DB: D1Database) =>
  ({ DB, ADMIN_TOKEN: 't', GITHUB_TOKEN: '', DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: '', REPO: 'a/b' }) as unknown as Env;

describe('reanalyze 异常回滚与错误外壳（单元级）', () => {
  // handleAdmin 对 /api/admin/ 前缀路径恒不返回 null（不变式），此处显式收窄
  const expectRes = (r: Response | null): Response => {
    if (!r) throw new Error('handleAdmin 对 /api/admin/ 路径不应返回 null');
    return r;
  };
  const analyze = async (db: D1Database) =>
    expectRes(await handleAdmin(new Request('http://internal/api/admin/sites/5/analyze', { method: 'POST' }), new URL('http://internal/api/admin/sites/5/analyze'), stubEnv(db)));

  it('流水线删除原行后抛异常 → 回滚原行并返回 502 {error:fetch_failed}', async () => {
    const { calls, db } = makeStubDb(false);
    const res = await analyze(db);
    expect(res.status).toBe(502);
    expect(await getJson(res)).toMatchObject({ error: 'fetch_failed' });
    expect(calls).toEqual(['get', 'delete', 'dupcheck', 'boom', 'restore']); // 删除后异常 → 回滚插入发生（R4：回滚后不再 prune）
  });
  it('回滚插入自身 UNIQUE 冲突 → 不再抛出，仍返回 502 统一信封', async () => {
    const { calls, db } = makeStubDb(true);
    const res = await analyze(db);
    expect(res.status).toBe(502);
    expect(await getJson(res)).toMatchObject({ error: 'fetch_failed' });
    expect(calls).toEqual(['get', 'delete', 'dupcheck', 'boom', 'restore']);
  });
  it('路由体内无兜底位置抛异常 → 错误外壳产出 500 JSON {error:fetch_failed}（而非 Cloudflare 纯文本）', async () => {
    const brokenDb = { prepare: () => { throw new Error('D1 完全不可用'); } } as unknown as D1Database;
    const res = expectRes(await handleAdmin(new Request('http://internal/api/admin/sites'), new URL('http://internal/api/admin/sites'), stubEnv(brokenDb)));
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await getJson(res)).toEqual({ error: 'fetch_failed', message: '服务器内部错误' });
  });
});
