import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFileSync } from 'node:fs';
import { analyzeAndUpsert, buildPageText } from '../src/pipeline';
import { insertSite, updateSite, deleteSite, getSiteByUrl, listSites, allPublishedRows, allCategories, upsertCategory } from '../src/db';

const mf = new Miniflare({ log: new Log(LogLevel.ERROR), modules: true, script: 'export default{}', d1Databases: ['DB'], d1Persist: false });
// 环境适配（相对 brief Step1 的两处必要偏差，语义不变）：
// 1) 本机 miniflare 3.20250109 的 getD1Database() 返回 Promise，必须 await；
// 2) 其 db.exec 按“换行”切分语句，schema.sql 的行尾注释与多行建表需先压平成单行（分号分隔仍被接受）。
let db: any;
beforeAll(async () => {
  db = await mf.getD1Database('DB');
  await db.exec(readFileSync('schema.sql', 'utf8').replace(/--.*$/gm, '').replace(/\s+/g, ' '));
});
afterAll(async () => { await mf.dispose(); });
const fakeHtml = (t: string) => (async (u: any) => new Response(`<title>${t}</title><meta name="description" content="desc-${t}">`, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
describe('analyzeAndUpsert（无 AI 降级路径）', () => {
  it('入库 pending + 默认分类 + favicon 模板 logo', async () => {
    const env: any = { DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: 'https://icons.test/ip3/{host}.ico' };
    const r = await analyzeAndUpsert({ url: 'https://NewSite.cn/x', source: 'manual' }, env, db, { fetchImpl: fakeHtml('新站') });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.row).toMatchObject({ url: 'https://newsite.cn/x', title: '新站', taxonomy: '未分类', status: 'pending', logo: 'https://icons.test/ip3/newsite.cn.ico' }); }
  });
  it('重复 URL 返回 dup_url 且不新增', async () => {
    const r = await analyzeAndUpsert({ url: 'https://newsite.cn/x/', source: 'manual' }, { DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: 'x{host}y' } as any, db, { fetchImpl: fakeHtml('x') });
    expect(r).toEqual({ ok: false, code: 'dup_url' });
  });
  it('显式字段优先于抓取（扩展直通）', async () => {
    const r = await analyzeAndUpsert({ url: 'https://b.cn', title: '给定题', taxonomy: 'T1', term: 'S1', source: 'extension' }, {} as any, db, { fetchImpl: fakeHtml('页内题') });
    if (!r.ok) throw new Error('should pass');
    expect(r.row).toMatchObject({ title: '给定题', taxonomy: 'T1', term: 'S1' });
  });
});

const aiEnv = (extra: Record<string, unknown> = {}): any => ({
  DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: 'f{host}b',
  AI_BASE_URL: 'https://ai.test/v1/', AI_API_KEY: 'k', AI_MODEL: 'm', ...extra,
});

// 路由式 fake fetch：同一个 fetchImpl 同时服务“页面抓取”和“AI chat/completions”两类请求
const routerFetch = ({ pageHtml, aiContent, calls, bodies }: { pageHtml: string; aiContent: unknown; calls: string[]; bodies: string[] }) =>
  (async (u: any, init?: any) => {
    calls.push(String(u));
    if (String(u).includes('ai.test')) {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ choices: [{ message: { content: typeof aiContent === 'string' ? aiContent : JSON.stringify(aiContent) } }] }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(pageHtml, { headers: { 'content-type': 'text/html' } });
  }) as unknown as typeof fetch;

describe('analyzeAndUpsert（AI 路径与降级细则）', () => {
  it('AI 全链路：剥标签正文喂给 AI，结果入库并补 categories', async () => {
    const calls: string[] = []; const bodies: string[] = [];
    const env = aiEnv();
    const fetchImpl = routerFetch({
      calls, bodies,
      pageHtml: '<html><head><script>var x="<div>";</script><title>页题</title></head><body><div>正文一</div><div>正文二</div></body></html>',
      aiContent: { title: 'AI标题', description: 'AI描述', taxonomy: '工具', term: '设计', new_category: true },
    });
    const r = await analyzeAndUpsert({ url: 'https://aitest.cn', source: 'manual' }, env, db, { fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row).toMatchObject({ title: 'AI标题', description: 'AI描述', taxonomy: '工具', term: '设计', status: 'pending', logo: 'faitest.cnb' });
      expect(typeof r.row.created_at).toBe('string');
      expect(r.row.created_at.length).toBeGreaterThan(0);
    }
    expect(calls).toContain('https://aitest.cn');
    expect(calls.some((c) => c.includes('ai.test/v1/chat/completions'))).toBe(true);
    const parsed = JSON.parse(bodies[0]!);
    const userMsg = parsed.messages.find((m: any) => m.role === 'user').content as string;
    // pageText = 剥标签（含 script 内容）后的正文，标题文本也在其中
    expect(userMsg).toContain('页面正文摘要：页题 正文一 正文二');
    expect(userMsg).not.toContain('<div>');
    expect(userMsg).toContain('原标题：页题');
    const sysMsg = parsed.messages.find((m: any) => m.role === 'system').content as string;
    expect(sysMsg).toContain('未分类'); // 之前用例已沉淀默认分类，AI 提示词内嵌现有分类清单
    const cats = await allCategories(db);
    expect(cats).toContainEqual({ taxonomy: '工具', term: '设计', icon: 'fas fa-folder-open fa-lg', sort: 0 });
  });

  it('AI 返回纯空白 taxonomy（带 new_category）→ 整条降级为基线+DEFAULT_TAXONOMY，不半采信', async () => {
    const calls: string[] = []; const bodies: string[] = [];
    const fetchImpl = routerFetch({
      calls, bodies,
      pageHtml: '<title>页题X</title><meta name="description" content="页述X">',
      aiContent: { title: 'AI题', description: 'AI述', taxonomy: '   ', term: '  ', new_category: true },
    });
    const r = await analyzeAndUpsert({ url: 'https://wstax.cn', source: 'manual' }, aiEnv(), db, { fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row).toMatchObject({ title: '页题X', description: '页述X', taxonomy: '未分类', term: '' });
  });

  it('页面不可达 → 按 spec §4.4 存基线缺失行：title 退化为 host，仍 pending 等人工', async () => {
    const env = aiEnv();
    const calls: string[] = [];
    const fetchImpl = (async (u: any) => { calls.push(String(u)); return new Response('boom', { status: 500 }); }) as unknown as typeof fetch;
    const r = await analyzeAndUpsert({ url: 'https://deadSite.cn/p', source: 'import' }, env, db, { fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row).toMatchObject({ title: 'deadsite.cn', description: '', taxonomy: '未分类', term: '', status: 'pending', source: 'import' });
    // 抓不到页面则不调 AI
    expect(calls.some((c) => c.includes('ai.test'))).toBe(false);
  });

  it('显式 title（无 taxonomy）非直通：参与分析但显式字段覆盖', async () => {
    const r = await analyzeAndUpsert({ url: 'https://partial.cn', title: '指定题' }, { DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: 'x{host}y' } as any, db, { fetchImpl: fakeHtml('页内题') });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row).toMatchObject({ title: '指定题', taxonomy: '未分类' });
  });

  it('opts.url 先 trim 再规范化；url_raw 存 trim 后的原样', async () => {
    const r = await analyzeAndUpsert({ url: '  https://trimmed.cn/x?q=1  ' }, { DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: '' } as any, db, { fetchImpl: fakeHtml('t') });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row).toMatchObject({ url: 'https://trimmed.cn/x?q=1', url_raw: 'https://trimmed.cn/x?q=1', logo: '' });
  });

  it('非法 URL → bad_request', async () => {
    expect(await analyzeAndUpsert({ url: '   ' }, {} as any, db)).toEqual({ ok: false, code: 'bad_request' });
    expect(await analyzeAndUpsert({ url: 'https://' }, {} as any, db)).toEqual({ ok: false, code: 'bad_request' });
  });

  it('直通路径 logo 显式优先，不套模板', async () => {
    const r = await analyzeAndUpsert({ url: 'https://logo.cn', title: '题', taxonomy: 'T2', logo: 'my.png' }, { DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: 'x{host}y' } as any, db, { fetchImpl: fakeHtml('x') });
    if (!r.ok) throw new Error('should pass');
    expect(r.row.logo).toBe('my.png');
  });

  it('AI 合法但 description 为空串 → 回落基线 description（不留空）', async () => {
    const calls: string[] = []; const bodies: string[] = [];
    const fetchImpl = routerFetch({
      calls, bodies,
      pageHtml: '<title>页题E</title><meta name="description" content="页述E">',
      aiContent: { title: 'AI题E', description: '', taxonomy: '工具', term: '', new_category: false },
    });
    const r = await analyzeAndUpsert({ url: 'https://emptydesc.cn', source: 'manual' }, aiEnv(), db, { fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row).toMatchObject({ title: 'AI题E', description: '页述E', taxonomy: '工具' });
  });
});

describe('analyzeAndUpsert（并发竞态，Task 6 结转）', () => {
  it('同 URL 并发双写：恰一成功、另一为 dup_url 且不抛异常', async () => {
    // 直通路径（title+taxonomy 齐）零网络，两次调用都会通过前置查重后并发走到 INSERT，
    // 由 UNIQUE(url) 触发竞态：后提交者必须被 catch 转为 {ok:false,code:'dup_url'}。
    const env = { DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: '' } as any;
    const opts = { url: 'https://race.test/dup', title: '竞态题', taxonomy: '竞态分' };
    const rs = await Promise.all([analyzeAndUpsert(opts, env, db), analyzeAndUpsert(opts, env, db)]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toEqual({ ok: false, code: 'dup_url' });
    const row = await getSiteByUrl(db, 'https://race.test/dup');
    expect(row?.title).toBe('竞态题');
  });
});

describe('db 助手（真实 D1 round-trip）', () => {
  it('insertSite 返回完整行（含 id 与 SQL 时间戳）', async () => {
    const row = await insertSite(db, { url: 'https://d1.test/a', url_raw: 'https://d1.test/a', title: '甲', description: '', logo: '', taxonomy: 'DT', term: '', status: 'pending', source: 'manual', sort: 0 });
    expect(row.id).toBeGreaterThan(0);
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
    const got = await getSiteByUrl(db, 'https://d1.test/a');
    expect(got).toEqual(row);
  });

  it('updateSite 部分字段 + 行不存在返回 null；deleteSite 删除', async () => {
    const row = await insertSite(db, { url: 'https://d1.test/b', url_raw: 'b', title: '乙', description: '', logo: '', taxonomy: 'DT', term: '', status: 'pending', source: 'manual', sort: 0 });
    const upd = await updateSite(db, row.id, { title: '乙改', status: 'published' });
    expect(upd).toMatchObject({ id: row.id, title: '乙改', status: 'published', url: 'https://d1.test/b' });
    expect(await updateSite(db, 10 ** 9, { title: 'x' })).toBeNull();
    await deleteSite(db, row.id);
    expect(await getSiteByUrl(db, 'https://d1.test/b')).toBeNull();
  });

  it('listSites：筛选 + 分页（默认 page=1, perPage=50）与 total', async () => {
    for (const [i, status] of [['p1', 'pending'], ['p2', 'pending'], ['p3', 'published'], ['p4', 'published']] as const) {
      await insertSite(db, { url: `https://list.test/${i}`, url_raw: i, title: `列表${i}`, description: '', logo: '', taxonomy: 'LX', term: '', status, source: 'manual', sort: 0 });
    }
    const all = await listSites(db, { q: '列表p', taxonomy: 'LX' });
    expect(all.total).toBe(4);
    expect(all.rows.length).toBe(4);
    const p2 = await listSites(db, { status: 'published', q: '列表p', page: 2, perPage: 3 });
    expect(p2.total).toBe(2);
    expect(p2.rows.length).toBe(0); // 第 2 页越界：空页但 total 不变
    const p2b = await listSites(db, { status: 'published', q: '列表p', perPage: 3 });
    expect(p2b.rows.map((r) => r.status)).toEqual(['published', 'published']);
    const p3 = await listSites(db, { q: '列表p', page: 2, perPage: 3 });
    expect(p3.total).toBe(4);
    expect(p3.rows.length).toBe(1);
    // q 中的 LIKE 通配符按字面量处理
    expect((await listSites(db, { q: 'list%test' })).total).toBe(0);
  });

  it('allPublishedRows 按 (taxonomy, term, sort, id) 稳定排序', async () => {
    const a = await insertSite(db, { url: 'https://ord.test/1', url_raw: '1', title: '一', description: '', logo: '', taxonomy: 'ZZ排序', term: 'T', status: 'published', source: 'manual', sort: 2 });
    const b = await insertSite(db, { url: 'https://ord.test/2', url_raw: '2', title: '二', description: '', logo: '', taxonomy: 'ZZ排序', term: 'T', status: 'published', source: 'manual', sort: 1 });
    const c = await insertSite(db, { url: 'https://ord.test/3', url_raw: '3', title: '三', description: '', logo: '', taxonomy: 'ZZ排序', term: 'T', status: 'published', source: 'manual', sort: 1 });
    const rows = (await allPublishedRows(db)).filter((r) => r.taxonomy === 'ZZ排序');
    expect(rows.map((r) => r.id)).toEqual([b.id, c.id, a.id]);
    expect(rows.every((r) => r.status === 'published')).toBe(true);
  });

  it('upsertCategory 幂等且冲突不覆盖已有 icon/sort', async () => {
    await upsertCategory(db, { taxonomy: 'UC', term: 'u1', icon: 'first', sort: 7 });
    await upsertCategory(db, { taxonomy: 'UC', term: 'u1', icon: 'second', sort: 9 });
    const cats = (await allCategories(db)).filter((c) => c.taxonomy === 'UC');
    expect(cats).toEqual([{ taxonomy: 'UC', term: 'u1', icon: 'first', sort: 7 }]);
    expect(await getSiteByUrl(db, 'https://nope.invalid/')).toBeNull();
  });
});

describe('buildPageText', () => {
  it('剥标签、去 script/style 内容、压空白、截 4KB', () => {
    const big = '<div>' + '哈'.repeat(5000) + '</div>';
    const html = `<script>evil()</script><style>.x{}</style><h1>标题</h1>${big}`;
    const t = buildPageText(html);
    expect(t.length).toBeLessThanOrEqual(4096);
    expect(t).not.toContain('<');
    expect(t).not.toContain('evil');
    expect(t.startsWith('标题 ')).toBe(true);
    expect(buildPageText('a\n  b\t<p>c</p>')).toBe('a b c');
  });
});
