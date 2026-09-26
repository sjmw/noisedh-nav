// spec §6 核心路由集成测试：按 brief Step 3 用 wrangler unstable_dev 起真实 Worker
// （本地 D1 sqlite，vars 见 test/wrangler.routes.json，ADMIN_TOKEN='t'）。
// schema 初始化走 `wrangler d1 execute --local`（同一 persist 目录），与部署路径一致。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { unstable_dev } from 'wrangler';
import type { Unstable_DevWorker as UnstableDevWorker } from 'wrangler';

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
  it('非 /api/admin 路径不由 handleAdmin 接管（null 透传，暂由 index 兜底）', async () => {
    const res = await dev.fetch('/api/other');
    expect(res.status).toBe(200); // index 占位 'ok'，Task 10 扩展层接管
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
  it('PATCH 白名单：改 title/status/sort 生效，白名单外键（url/id）忽略', async () => {
    const id = (await getJson(await post('/api/admin/sites', { url: 'https://patchme.invalid' }))).site.id;
    const res = await dev.fetch(`/api/admin/sites/${id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ title: '补丁题', status: 'published', sort: 5, url: 'https://evil.invalid', id: 999 }) });
    expect(res.status).toBe(200);
    const { site } = await getJson(res);
    expect(site).toMatchObject({ id, title: '补丁题', status: 'published', sort: 5, url: 'https://patchme.invalid' });
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
  it('POST :id/analyze 重跑流水线：标题重算但保留 status/sort，id 变化', async () => {
    const created = (await getJson(await post('/api/admin/sites', { url: 'https://reanalyze.invalid', title: '初始题' }))).site;
    await dev.fetch(`/api/admin/sites/${created.id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ status: 'published', sort: 3 }) });
    const res = await post(`/api/admin/sites/${created.id}/analyze`, {});
    expect(res.status).toBe(200);
    const { site } = await getJson(res);
    expect(site.id).not.toBe(created.id);
    expect(site).toMatchObject({ url: created.url, status: 'published', sort: 3 });
    expect(site.title).not.toBe('初始题'); // 重跑不带旧显式字段 → 降级题（host）
    await dev.fetch(`/api/admin/sites/${site.id}`, { method: 'DELETE', headers: auth }); // 清理
  });
  it('POST :id/analyze 不存在 id → 404', async () => {
    expect((await post('/api/admin/sites/888888/analyze', {})).status).toBe(404);
  });
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
  it('html 超 1MB → too_large 413；缺 html → 400', async () => {
    const big = await post('/api/admin/import', { html: 'x'.repeat(1024 * 1024 + 10) });
    expect(big.status).toBe(413);
    expect(await getJson(big)).toMatchObject({ error: 'too_large' });
    expect((await post('/api/admin/import', {})).status).toBe(400);
    expect((await dev.fetch('/api/admin/import', { method: 'POST', headers: authJson, body: '{not json' })).status).toBe(400);
  });
});

describe('/api/admin/categories', () => {
  it('POST 补位 → GET 可见（默认 icon）；缺 taxonomy → 400；DELETE 按 (taxonomy,term)', async () => {
    expect((await post('/api/admin/categories', { taxonomy: 'CT', term: 'ct1' })).status).toBe(204);
    await post('/api/admin/categories', { taxonomy: 'CT', term: 'ct1', icon: 'should-ignore' });
    const cats = (await getJson(await dev.fetch('/api/admin/categories', { headers: auth }))).categories;
    expect(cats).toContainEqual({ taxonomy: 'CT', term: 'ct1', icon: 'fas fa-folder-open fa-lg', sort: 0 });
    expect((await post('/api/admin/categories', { term: 'x' })).status).toBe(400);
    expect((await dev.fetch('/api/admin/categories?taxonomy=CT&term=ct1', { method: 'DELETE', headers: auth })).status).toBe(204);
    const after = (await getJson(await dev.fetch('/api/admin/categories', { headers: auth }))).categories;
    expect(after.some((c: { taxonomy: string }) => c.taxonomy === 'CT')).toBe(false);
  });
});

describe('未知路径与 publish 接缝', () => {
  it('/api/admin/zzz → 404；POST /api/admin/publish 在 Task 8 前为 404 占位', async () => {
    const res = await dev.fetch('/api/admin/zzz', { headers: auth });
    expect(res.status).toBe(404);
    const pub = await post('/api/admin/publish', {});
    expect(pub.status).toBe(404);
  });
});
