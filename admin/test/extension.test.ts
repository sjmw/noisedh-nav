// Task 10 扩展兼容层 + notifications 集成测试（附录 A 契约 / spec §6.1）。
// 每个用例按 popup.js 原样请求形状断言（方法/路径/字段名/Bearer 头/2xx 判定），
// 装具复用 routes.test.ts 的 unstable_dev 模式（独立 persist 目录避免并发串扰）。
// 鉴权矩阵（spec §6:125/137 + §11:170 + popup.js 实测）：
//   公开：GET /data、GET /data/{file}、GET /api/search、GET /api/notifications
//   Bearer：POST /api/yaml、DELETE /api/delete、POST /api/server-settings（写面，index 层 requireAuth）

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { unstable_dev } from 'wrangler';
import { handleExtension } from '../src/extension';
import { handleNotifications } from '../src/notifications';
import type { Unstable_DevWorker as UnstableDevWorker } from 'wrangler';
import type { Env } from '../src/types';

const CFG = 'test/wrangler.routes.json';
const PERSIST = '.wrangler-ext';
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

const jf = async (res: { json(): Promise<unknown> }): Promise<any> => await res.json();
const txt = async (res: { text(): Promise<string> }): Promise<string> => await res.text();

// 管理页通道造数（title+taxonomy 同给 → 流水线直通分支，不发真实抓取）
const mkSite = async (url: string, extra: Record<string, unknown> = {}) =>
  (await jf(await dev.fetch('/api/admin/sites', { method: 'POST', headers: authJson, body: JSON.stringify({ url, ...extra }) }))).site;
const publish = async (id: number) => dev.fetch(`/api/admin/sites/${id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ status: 'published' }) });

// popup.js:1195-1199 原样形状
const yamlBody = (entry: Record<string, unknown>, filename = 'webstack.yml') => ({
  filename,
  newDataEntry: { title: '缺题', url: 'https://blank.invalid', logo: '', description: '', kind: 'webstack', taxonomy: '缺类', ...entry },
  allowCreateCategory: true,
});
const postYaml = (body: unknown, headers: Record<string, string> = authJson) =>
  dev.fetch('/api/yaml', { method: 'POST', headers, body: JSON.stringify(body) });

describe('GET /data（文件列表，公开）', () => {
  it('无 Bearer → 200 string[]，与附录 A popup.js:597,600 一致', async () => {
    const res = await dev.fetch('/data');
    expect(res.status).toBe(200);
    expect(await jf(res)).toEqual(['webstack.yml', 'friendlinks.yml', 'headers.yml']);
  });
});

describe('GET /data/{encodeURIComponent(name)}（文件内容）', () => {
  it('webstack.yml → D1 导出 yaml 文本；url 用 url_raw 原样（Task 9 裁定 A）', async () => {
    const s = await mkSite('https://datayml.invalid/x/', { title: 'YML题', taxonomy: 'EXTY' });
    await publish(s.id);
    const res = await dev.fetch('/data/' + encodeURIComponent('webstack.yml'));
    expect(res.status).toBe(200);
    const text = await txt(res); // popup.js:607 用 res.text()
    expect(text).toContain('---');
    expect(text).toContain('taxonomy: EXTY');
    expect(text).toContain('https://datayml.invalid/x/'); // url_raw 带尾斜杠（规范化 url 无斜杠）
    expect(text).toContain('title: YML题');
  });
  it('未知文件 → 404 {error:bad_request}（7 码枚举无 not_found，与既有路由口径一致）', async () => {
    const res = await dev.fetch('/data/nope.yml');
    expect(res.status).toBe(404);
    expect(await jf(res)).toMatchObject({ error: 'bad_request' });
  });
});

describe('POST /api/yaml（收藏写入，Bearer）', () => {
  it('无/错 token → 401 {error:unauthorized}（写接口不匿名，spec §11）', async () => {
    for (const headers of [{ 'Content-Type': 'application/json' }, { ...authJson, Authorization: 'Bearer nope' }] as const) {
      const res = await postYaml(yamlBody({ url: 'https://yaml401.invalid' }), headers);
      expect(res.status).toBe(401);
      expect(await jf(res)).toMatchObject({ error: 'unauthorized' });
    }
  });
  it('webstack.yml 新收录 → 204；D1 出现 pending 行（直通不抓取，source=extension，url_raw 原样）', async () => {
    const res = await postYaml(yamlBody({ title: '新藏', url: 'HTTPS://New1.Invalid/a/', logo: 'n.png', description: '藏摘', taxonomy: 'EXT', term: '子A' }));
    expect(res.status).toBe(204); // popup 只判 res.ok
    const list = await jf(await dev.fetch('/api/admin/sites?q=new1', { headers: auth }));
    expect(list.total).toBe(1);
    expect(list.sites[0]).toMatchObject({
      url: 'https://new1.invalid/a', url_raw: 'HTTPS://New1.Invalid/a/', title: '新藏', description: '藏摘',
      logo: 'n.png', taxonomy: 'EXT', term: '子A', status: 'pending', source: 'extension',
    });
  });
  it('friendlinks.yml / headers.yml → 501 {error:bad_request, message 含 只读}（不纳入 D1，写面拒绝）', async () => {
    for (const f of ['friendlinks.yml', 'headers.yml']) {
      const res = await postYaml(yamlBody({ title: 't', url: 'https://ro.invalid', kind: f.split('.')[0], taxonomy: undefined }, f));
      expect(res.status).toBe(501);
      const body = await jf(res);
      expect(body.error).toBe('bad_request');
      expect(String(body.message)).toContain('只读');
    }
  });
  it('严格白名单：文件名（小写）不含 webstack → 同款 501 信封且不落库', async () => {
    // 修复前 kindOf 未知名默认落 webstack 域 → 任意文件名都可写；popup 只发三型文件名，兼容不受影响
    const res = await postYaml(yamlBody({ title: '白名单测', url: 'https://wlstrict.invalid' }, 'notes.yml'));
    expect(res.status).toBe(501);
    const body = await jf(res);
    expect(body.error).toBe('bad_request');
    expect(String(body.message)).toContain('notes.yml');
    expect((await jf(await dev.fetch('/api/admin/sites?q=wlstrict', { headers: auth }))).total).toBe(0);
    // 历史路径形态（kindOf 兼容注释）仍放行：含 webstack 即视为 webstack 域
    const ok = await postYaml(yamlBody({ title: '路径形', url: 'https://wlpath.invalid' }, 'data/webstack.yml'));
    expect(ok.status).toBe(204);
    const list = await jf(await dev.fetch('/api/admin/sites?q=wlpath', { headers: auth }));
    expect(list.total).toBe(1);
    await dev.fetch(`/api/admin/sites/${list.sites[0].id}`, { method: 'DELETE', headers: auth }); // 清理
  });
  it('缺 url / 非法 URL → 400 bad_request', async () => {
    expect((await postYaml({ filename: 'webstack.yml', newDataEntry: { title: 'x', kind: 'webstack', taxonomy: 'T' }, allowCreateCategory: true })).status).toBe(400);
    expect((await postYaml(yamlBody({ url: 'javascript:alert(1)' }))).status).toBe(400);
  });
  it('重复 URL（ledger 裁定）→ 更新显式非空字段、保留 status 不自动发布、不重跑抓取/AI、204、仅一行、id 不变', async () => {
    const s = await mkSite('https://duped.invalid', { title: '原题', taxonomy: 'EXTD' });
    await dev.fetch(`/api/admin/sites/${s.id}`, { method: 'PATCH', headers: authJson, body: JSON.stringify({ status: 'published', term: '原term', description: '原摘要' }) });
    const res = await postYaml(yamlBody({ title: '改题', url: 'https://duped.invalid/', logo: 'p2.png', description: '新摘要', taxonomy: 'EXT2' }));
    expect(res.status).toBe(204);
    const list = await jf(await dev.fetch('/api/admin/sites?q=duped', { headers: auth }));
    expect(list.total).toBe(1); // 不新增行
    const row = list.sites[0];
    expect(row.id).toBe(s.id); // 更新原行而非重插（重插/重分析都会换 id）
    expect(row).toMatchObject({ title: '改题', description: '新摘要', logo: 'p2.png', taxonomy: 'EXT2', term: '原term', status: 'published', url_raw: 'https://duped.invalid' });
    // status 保留 published（不自动发布语义：pending 行同路径也只更新字段，不触碰 status）
  });
  it('pending 行重复收藏 → 更新字段但仍 pending', async () => {
    const res = await postYaml(yamlBody({ title: '待审一', url: 'https://duppending.invalid', taxonomy: 'EXT' }));
    expect(res.status).toBe(204);
    expect((await postYaml(yamlBody({ title: '待审二', url: 'https://duppending.invalid/', taxonomy: 'EXT' }))).status).toBe(204);
    const list = await jf(await dev.fetch('/api/admin/sites?q=duppending', { headers: auth }));
    expect(list.total).toBe(1);
    expect(list.sites[0]).toMatchObject({ title: '待审二', status: 'pending' });
  });
});

describe('GET /api/search（公开）', () => {
  it('无 Bearer 可用；字段名与 renderSearchResults 消费逐字段一致（popup.js:1260-1283）', async () => {
    const res = await dev.fetch(`/api/search?keyword=${encodeURIComponent('新藏')}&filePath=${encodeURIComponent('webstack.yml')}`);
    expect(res.status).toBe(200);
    const items = await jf(res);
    expect(Array.isArray(items)).toBe(true);
    const hit = items.find((i: any) => i.title === '新藏');
    expect(hit).toBeDefined();
    expect(Object.keys(hit).sort()).toEqual(['description', 'kind', 'taxonomy', 'term', 'title', 'url']);
    expect(hit).toMatchObject({ kind: 'webstack', title: '新藏', taxonomy: 'EXT', term: '子A', description: '藏摘' });
    expect(hit.url).toBe('HTTPS://New1.Invalid/a/'); // 展示优先 url_raw（Task 9 裁定 A）
  });
  it('LIKE 三字段：仅 description 命中', async () => {
    await mkSite('https://descmatch.invalid', { title: '标题甲', taxonomy: 'EXTS', description: '摘要丙独一' });
    const items = await jf(await dev.fetch('/api/search?keyword=' + encodeURIComponent('摘要丙独一') + '&filePath=webstack.yml'));
    expect(items.some((i: any) => i.title === '标题甲')).toBe(true);
  });
  it('filePath 命中 friendlinks/headers → 200 空数组（数据不纳入 D1；popup 渲染「没有找到匹配结果」）', async () => {
    const items = await jf(await dev.fetch('/api/search?keyword=x&filePath=friendlinks.yml'));
    expect(items).toEqual([]);
  });
  it('keyword 空 → 200 空数组', async () => {
    expect(await jf(await dev.fetch('/api/search?keyword=&filePath=webstack.yml'))).toEqual([]);
  });
});

describe('DELETE /api/delete（Bearer）', () => {
  it('无 token → 401', async () => {
    const res = await dev.fetch('/api/delete', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'webstack.yml', title: 'x', kind: 'webstack' }) });
    expect(res.status).toBe(401);
    expect(await jf(res)).toMatchObject({ error: 'unauthorized' });
  });
  it('friendlinks.yml → 501 只读', async () => {
    const res = await dev.fetch('/api/delete', { method: 'DELETE', headers: authJson, body: JSON.stringify({ filename: 'friendlinks.yml', title: 'x', kind: 'friendlinks' }) });
    expect(res.status).toBe(501);
    expect(String((await jf(res)).message)).toContain('只读');
  });
  it('严格白名单：文件名（小写）不含 webstack → 501（修复前 kindOf 未知名默认按 webstack 域处理）', async () => {
    const res = await dev.fetch('/api/delete', { method: 'DELETE', headers: authJson, body: JSON.stringify({ filename: 'notes.yml', title: '查无此题', kind: 'webstack' }) });
    expect(res.status).toBe(501);
    expect(await jf(res)).toMatchObject({ error: 'bad_request' });
  });
  it('webstack 同名两行 → 删最早 id（204），后一行保留', async () => {
    const a = await mkSite('https://collide1.invalid', { title: '同名题', taxonomy: 'EXTD' });
    const b = await mkSite('https://collide2.invalid', { title: '同名题', taxonomy: 'EXTD' });
    const res = await dev.fetch('/api/delete', { method: 'DELETE', headers: authJson, body: JSON.stringify({ filename: 'webstack.yml', title: '同名题', kind: 'webstack' }) });
    expect(res.status).toBe(204);
    const list = await jf(await dev.fetch('/api/admin/sites?q=collide', { headers: auth }));
    expect(list.sites.map((s: any) => s.id)).toEqual([b.id]); // 最早 id=a.id 已删
  });
  it('title 不存在 → 204 幂等（popup 只判 res.ok）', async () => {
    const res = await dev.fetch('/api/delete', { method: 'DELETE', headers: authJson, body: JSON.stringify({ filename: 'webstack.yml', title: '查无此题', kind: 'webstack' }) });
    expect(res.status).toBe(204);
  });
});

describe('POST /api/server-settings（Bearer，扁平字符串对象）', () => {
  it('无 token → 401；正常 → 204（popup.js:185-198 原样键值）', async () => {
    const payload = { webhookUrl: 'https://hook.invalid', telegramChatId: '123', rssChannelTitle: '频道' };
    const noAuth = await dev.fetch('/api/server-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    expect(noAuth.status).toBe(401);
    expect((await jf(noAuth)).error).toBe('unauthorized');
    const res = await dev.fetch('/api/server-settings', { method: 'POST', headers: authJson, body: JSON.stringify(payload) });
    expect(res.status).toBe(204);
    // 同键重推（upsert 覆盖）也须 204
    expect((await dev.fetch('/api/server-settings', { method: 'POST', headers: authJson, body: JSON.stringify({ webhookUrl: 'https://hook2.invalid' }) })).status).toBe(204);
  });
  it('非字符串值 → 400（扁平字符串契约）', async () => {
    const res = await dev.fetch('/api/server-settings', { method: 'POST', headers: authJson, body: JSON.stringify({ a: { b: 1 } }) });
    expect(res.status).toBe(400);
    expect(await jf(res)).toMatchObject({ error: 'bad_request' });
  });
});

describe('GET /api/notifications（公开，spec §6:137）', () => {
  it('无任何鉴权头 → 200；只含 published；形状 {title,description,url,timestamp}；timestamp 为 ISO；url=url_raw||url', async () => {
    const pend = await mkSite('https://notipending.invalid', { title: '通知藏', taxonomy: 'EXTN' }); // pending 最新，若未过滤必占首位
    const ok1 = await mkSite('https://notipub1.invalid/', { title: '通知一', taxonomy: 'EXTN' });
    await publish(ok1.id);
    const res = await dev.fetch('/api/notifications'); // 不带 headers：前台 component_header.js 原样
    expect(res.status).toBe(200);
    const items = await jf(res);
    expect(Array.isArray(items)).toBe(true);
    const one = items.find((i: any) => i.title === '通知一');
    expect(one).toBeDefined();
    expect(Object.keys(one).sort()).toEqual(['description', 'timestamp', 'title', 'url']);
    expect(one.url).toBe('https://notipub1.invalid/'); // url_raw 尾斜杠保真
    expect(one.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(items.some((i: any) => i.title === '通知藏' || i.url.includes('notipending'))).toBe(false);
    expect(items.every((i: any) => i.title !== '同名题' || true)).toBe(true);
    await dev.fetch(`/api/admin/sites/${pend.id}`, { method: 'DELETE', headers: auth });
  });
  it('上限 20 条', async () => {
    for (let i = 0; i < 22; i++) {
      const s = await mkSite(`https://bulk${i}.invalid`, { title: `批量${i}`, taxonomy: 'EXTB' });
      await publish(s.id);
    }
    const items = await jf(await dev.fetch('/api/notifications'));
    expect(items.length).toBe(20);
  });
});

// ── 单元级：外部 fetch 的接口不能走 unstable_dev 真实网络（.invalid-host 口径），
// 直接调用 handleExtension/handleNotifications + 假 fetch/假 D1 断言透传缓存、SQL 形态与映射 ──

const stubEnv = (DB: D1Database): Env =>
  ({ DB, ADMIN_TOKEN: 't', GITHUB_TOKEN: 'ghp-x', DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: '', REPO: 'noisedh/noisedh-nav' }) as unknown as Env;

const directExt = (path: string, init: RequestInit = {}, DB: D1Database, deps = {}) =>
  handleExtension(new Request('http://internal' + path, init), new URL('http://internal' + path), stubEnv(DB), deps);

describe('单元：friendlinks/headers 读透传 + 5 分钟缓存', () => {
  const db = { prepare: () => { throw new Error('读透传路径不应触库'); } } as unknown as D1Database;
  it('ghGet 透传内容；TTL 内第二次请求不再发外部 fetch（模块级缓存，per-isolate）', async () => {
    let hits = 0;
    let lastUrl = '';
    const yml = '- friendname: 友链\n  url: https://f.example/\n'; // 含中文，验 UTF-8 解码
    const fetchImpl = (async (url: string | URL) => {
      hits++;
      lastUrl = String(url);
      return Response.json({ content: Buffer.from(yml, 'utf8').toString('base64') + '\n', sha: 'abc' });
    }) as typeof fetch;
    const res1 = await directExt('/data/friendlinks.yml', {}, db, { fetchImpl });
    expect(res1!.status).toBe(200);
    expect(await res1!.text()).toBe(yml);
    expect(lastUrl).toContain('/repos/noisedh/noisedh-nav/contents/data/friendlinks.yml');
    const res2 = await directExt('/data/friendlinks.yml', {}, db, { fetchImpl });
    expect(await res2!.text()).toBe(yml);
    expect(hits).toBe(1); // 5min 内命中缓存
  });
  it('GitHub 非 2xx → 502 fetch_failed 统一信封', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    const res = await directExt('/data/headers.yml', {}, db, { fetchImpl });
    expect(res!.status).toBe(502);
    expect(await res!.json()).toMatchObject({ error: 'fetch_failed' });
  });
});

describe('单元：settings upsert SQL 与 notifications 查询形态', () => {
  it('POST /api/server-settings 每键一条 INSERT..ON CONFLICT(key) DO UPDATE（存 D1 settings 表）', async () => {
    const sqls: string[] = [];
    const binds: unknown[][] = [];
    const exec = {
      run: async () => ({}),
      first: async () => null,
      all: async () => ({ results: [] }),
    };
    const db = {
      prepare: (sql: string) => {
        sqls.push(sql);
        return { bind: (...v: unknown[]) => { binds.push(v); return exec; }, ...exec };
      },
    } as unknown as D1Database;
    const res = await directExt('/api/server-settings', { method: 'POST', headers: authJson, body: JSON.stringify({ a: '1', b: '2' }) }, db);
    expect(res!.status).toBe(204);
    const ups = sqls.filter((s) => s.includes('ON CONFLICT(key)'));
    expect(ups).toHaveLength(2);
    expect(ups[0]).toContain('INTO settings');
    expect(binds.filter((b) => b.length === 2)).toEqual([['a', '1'], ['b', '2']]);
  });
  it('GET /api/notifications：SQL 限定 published + updated_at DESC + LIMIT 20；时间戳 sqlite→ISO', async () => {
    let captured = '';
    const exec = {
      all: async () => ({
        results: [{ id: 1, url: 'https://a.invalid', url_raw: 'https://a.invalid/', title: 'A', description: '', logo: '', taxonomy: 'T', term: '', status: 'published', source: 'seed', sort: 0, created_at: 'x', updated_at: '2026-09-26 10:20:30' }],
      }),
      run: async () => ({}),
      first: async () => null,
    };
    const db = { prepare: (sql: string) => { captured = sql; return { bind: () => exec, ...exec }; } } as unknown as D1Database;
    const res = await handleNotifications(new Request('http://internal/api/notifications'), new URL('http://internal/api/notifications'), stubEnv(db));
    expect(res).not.toBeNull();
    expect(captured).toContain("status = 'published'");
    expect(captured).toContain('ORDER BY updated_at DESC');
    expect(captured).toContain('LIMIT 20');
    expect(await jf(res!)).toEqual([{ title: 'A', description: '', url: 'https://a.invalid/', timestamp: '2026-09-26T10:20:30Z' }]);
  });
});
