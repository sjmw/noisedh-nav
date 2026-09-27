// 管理扩展轮 Task 1：friendlinks / navitems 全量 CRUD、sites 批量删（sitesWhere 同源）、
// pair/taxonomy 计数、分类级联改名。miniflare 真 D1（同 pipeline.test.ts 模式），
// 每个 it 用 freshDb() 独立库，互不串数据。
import { describe, it, expect, afterAll } from 'vitest';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFileSync } from 'node:fs';
import {
  insertSite, listSites, getSiteByUrl, allCategories, upsertCategory,
  allFriendlinks, insertFriendlink, updateFriendlink, getFriendlinkById, deleteFriendlink,
  allNavitems, insertNavitem, updateNavitem, getNavitemById, deleteNavitem, countNavChildren,
  deleteByIds, sitesWhere, deleteSitesByFilter, deleteSitesByIds,
  countSitesByPair, countSitesByTaxonomy, renameTaxonomy, renameTerm,
} from '../src/db';
import type { SiteRow } from '../src/types';

const SCHEMA = readFileSync('schema.sql', 'utf8').replace(/--.*$/gm, '').replace(/\s+/g, ' ');
const mfList: Miniflare[] = [];
// 环境适配（同 pipeline.test.ts）：miniflare 3.x getD1Database() 返回 Promise 必须 await；exec 需压平 schema
async function freshDb(): Promise<any> {
  const mf = new Miniflare({ log: new Log(LogLevel.ERROR), modules: true, script: 'export default{}', d1Databases: ['DB'], d1Persist: false });
  mfList.push(mf);
  const db = await mf.getD1Database('DB');
  await db.exec(SCHEMA);
  return db;
}
afterAll(async () => { for (const mf of mfList) await mf.dispose(); });

const seedRow = (url: string, extra: Partial<SiteRow> = {}): Omit<SiteRow, 'id' | 'created_at' | 'updated_at'> => ({
  url, url_raw: url, title: '标题', description: '', logo: '',
  taxonomy: '默认分类', term: '', status: 'pending', source: 'manual', sort: 0, ...extra,
});

describe('friendlinks', () => {
  it('insert 返回含 id/时间戳完整行；update 部分字段；deleteFriendlink 单删', async () => {
    const db = await freshDb();
    const r = await insertFriendlink(db, { title: ' NoiseDH', url: 'https://fl1.test', description: '说明一', sort: 3 });
    expect(r.id).toBeTypeOf('number');
    expect(r).toMatchObject({ title: ' NoiseDH', url: 'https://fl1.test', description: '说明一', sort: 3 });
    expect(typeof r.created_at).toBe('string');
    expect(typeof r.updated_at).toBe('string');
    const u = await updateFriendlink(db, r.id, { sort: 7 });
    expect(u).toMatchObject({ id: r.id, title: ' NoiseDH', url: 'https://fl1.test', sort: 7 });
    // 空 patch = 原样读回；不存在 id = null
    expect(await updateFriendlink(db, r.id, {})).toEqual(u);
    expect(await updateFriendlink(db, 999999, { title: 'x' })).toBeNull();
    await deleteFriendlink(db, r.id);
    expect(await getFriendlinkById(db, r.id)).toBeNull();
  });

  it('deleteByIds 返回实删数；allFriendlinks 按 (sort,id)', async () => {
    const db = await freshDb();
    const a = await insertFriendlink(db, { title: 'A', url: 'https://a.test', description: '', sort: 2 });
    const b = await insertFriendlink(db, { title: 'B', url: 'https://b.test', description: '', sort: 1 });
    const c = await insertFriendlink(db, { title: 'C', url: 'https://c.test', description: '', sort: 2 });
    expect((await allFriendlinks(db)).map((r: any) => r.title)).toEqual(['B', 'A', 'C']); // sort 优先，同 sort 按 id
    expect(await deleteByIds(db, 'friendlinks', [a.id, b.id])).toBe(2);
    expect((await allFriendlinks(db)).map((r: any) => r.title)).toEqual(['C']);
  });
});

describe('navitems', () => {
  it('顶层与子项混插：allNavitems 顶层按 id、子项紧跟其父且组内按 (sort,id)', async () => {
    const db = await freshDb();
    const top1 = await insertNavitem(db, { item: '首页', icon: 'fas fa-home', link: '/', parent_id: null, sort: 10 });
    const top2 = await insertNavitem(db, { item: '关于', icon: '', link: '/about', parent_id: null, sort: 1 });
    const childA = await insertNavitem(db, { item: '文档', icon: '', link: '/doc', parent_id: top2.id, sort: 5 });
    const childB = await insertNavitem(db, { item: '博客', icon: '', link: '/blog', parent_id: top2.id, sort: 2 });
    expect([top1.id, top2.id, childA.id, childB.id]).toEqual([1, 2, 3, 4]);
    expect(top1.parent_id).toBeNull();
    expect((await allNavitems(db)).map((r: any) => r.item)).toEqual(['首页', '关于', '博客', '文档']);
    // countNavChildren 只数直属子项
    expect(await countNavChildren(db, top2.id)).toBe(2);
    expect(await countNavChildren(db, top1.id)).toBe(0);
    // 改 parent_id 生效：文档挂到首页下 → 紧跟首页
    expect(await updateNavitem(db, childA.id, { parent_id: top1.id })).toMatchObject({ id: childA.id, parent_id: top1.id });
    expect((await allNavitems(db)).map((r: any) => r.item)).toEqual(['首页', '文档', '关于', '博客']);
    expect(await countNavChildren(db, top2.id)).toBe(1);
    // deleteNavitem 单删 + deleteByIds 批量（忽略不存在 id 仍返回实删数）
    await deleteNavitem(db, childB.id);
    expect(await getNavitemById(db, childB.id)).toBeNull();
    expect(await deleteByIds(db, 'navitems', [top1.id, top2.id, 12345])).toBe(2);
    // 不级联：父被删后孤儿子项仍在（Task 5 路由层负责阻止/清理）
    expect((await allNavitems(db)).map((r: any) => r.item)).toEqual(['文档']);
  });
});

describe('sitesWhere / 批量删', () => {
  it('sitesWhere 构造与 listSites 同源：空 opts 空串；各筛选拼 AND；q 通配符转义', async () => {
    expect(sitesWhere({})).toEqual({ w: '', vals: [] });
    expect(sitesWhere({ status: 'pending', taxonomy: 'T', term: 's' })).toEqual({
      w: ' WHERE status = ? AND taxonomy = ? AND term = ?', vals: ['pending', 'T', 's'],
    });
    const { w, vals } = sitesWhere({ q: '50%_a\\b' });
    expect(w).toBe(` WHERE (title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`);
    expect(vals).toEqual(['%50\\%\\_a\\\\b%', '%50\\%\\_a\\\\b%', '%50\\%\\_a\\\\b%']);
  });

  it('deleteSitesByFilter 按 taxonomy 只删该分类并返回条数', async () => {
    const db = await freshDb();
    await insertSite(db, seedRow('https://f1.test', { taxonomy: '筛选甲' }));
    await insertSite(db, seedRow('https://f2.test', { taxonomy: '筛选甲', status: 'published' }));
    await insertSite(db, seedRow('https://f3.test', { taxonomy: '筛选乙' }));
    expect(await deleteSitesByFilter(db, { taxonomy: '筛选甲' })).toBe(2);
    const { rows } = await listSites(db);
    expect(rows.map((r) => r.url)).toEqual(['https://f3.test']);
  });

  it('deleteSitesByFilter 空 opts=全库删，返回实删数', async () => {
    const db = await freshDb();
    await insertSite(db, seedRow('https://wf1.test')); await insertSite(db, seedRow('https://wf2.test'));
    expect(await deleteSitesByFilter(db, {})).toBe(2);
    expect((await listSites(db)).total).toBe(0);
  });

  it('deleteSitesByIds 忽略不存在的 id 仍返回实删数', async () => {
    const db = await freshDb();
    const a = await insertSite(db, seedRow('https://d1.test'));
    const b = await insertSite(db, seedRow('https://d2.test'));
    expect(await deleteSitesByIds(db, [a.id, 987654, b.id])).toBe(2);
    expect((await listSites(db)).total).toBe(0);
    expect(await deleteSitesByIds(db, [])).toBe(0);
  });
});

describe('pair/taxonomy 计数（任意 status）', () => {
  it('pending + published 都计入', async () => {
    const db = await freshDb();
    await insertSite(db, seedRow('https://p1.test', { taxonomy: '工具', term: '设计', status: 'pending' }));
    await insertSite(db, seedRow('https://p2.test', { taxonomy: '工具', term: '设计', status: 'published' }));
    await insertSite(db, seedRow('https://p3.test', { taxonomy: '工具', term: '剪辑', status: 'published' }));
    await insertSite(db, seedRow('https://p4.test', { taxonomy: '其他', term: '', status: 'pending' }));
    expect(await countSitesByPair(db, '工具', '设计')).toBe(2);
    expect(await countSitesByPair(db, '工具', '不存在')).toBe(0);
    expect(await countSitesByTaxonomy(db, '工具')).toBe(3);
    expect(await countSitesByTaxonomy(db, '没有这类')).toBe(0);
  });
});

describe('级联改名', () => {
  it('renameTaxonomy 级联 categories 全部行与 sites', async () => {
    const db = await freshDb();
    await upsertCategory(db, { taxonomy: '旧名', term: '' });
    await upsertCategory(db, { taxonomy: '旧名', term: '子一' });
    await upsertCategory(db, { taxonomy: '别类', term: '' });
    await insertSite(db, { ...seedRow('https://rn.test'), taxonomy: '旧名', term: '子一' });
    await renameTaxonomy(db, '旧名', '新名');
    expect((await allCategories(db)).map((c) => c.taxonomy).sort()).toEqual(['别类', '新名', '新名']);
    expect((await getSiteByUrl(db, 'https://rn.test'))?.taxonomy).toBe('新名');
    expect((await getSiteByUrl(db, 'https://rn.test'))?.term).toBe('子一'); // term 不受影响
    expect(await countSitesByTaxonomy(db, '旧名')).toBe(0);
  });

  it('renameTerm 只改该分类下配对行，sites.updated_at 刷新', async () => {
    const db = await freshDb();
    await upsertCategory(db, { taxonomy: '类甲', term: '' });
    await upsertCategory(db, { taxonomy: '类甲', term: '旧子' });
    await upsertCategory(db, { taxonomy: '类甲', term: '邻子' });
    await insertSite(db, { ...seedRow('https://rt1.test'), taxonomy: '类甲', term: '旧子', status: 'pending' });
    await insertSite(db, { ...seedRow('https://rt2.test'), taxonomy: '类甲', term: '旧子', status: 'published' });
    await insertSite(db, { ...seedRow('https://rt3.test'), taxonomy: '类甲', term: '邻子' });
    await db.prepare(`UPDATE sites SET updated_at = '2000-01-01 00:00:00'`).run(); // 三行全部置为可识别旧值
    await renameTerm(db, '类甲', '旧子', '新子');
    const cats = await allCategories(db);
    expect(cats.filter((c) => c.taxonomy === '类甲').map((c) => c.term).sort()).toEqual(['', '新子', '邻子']);
    expect(await countSitesByPair(db, '类甲', '旧子')).toBe(0);
    expect(await countSitesByPair(db, '类甲', '新子')).toBe(2); // pending+published 均改
    expect((await getSiteByUrl(db, 'https://rt3.test'))?.term).toBe('邻子'); // 邻子不动
    expect((await getSiteByUrl(db, 'https://rt1.test'))?.updated_at).not.toBe('2000-01-01 00:00:00'); // 命中行（pending/published）刷新
    expect((await getSiteByUrl(db, 'https://rt2.test'))?.updated_at).not.toBe('2000-01-01 00:00:00');
    expect((await getSiteByUrl(db, 'https://rt3.test'))?.updated_at).toBe('2000-01-01 00:00:00'); // 未命中行不动
  });
});
