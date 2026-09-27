// 冒烟修复轮：分类形态归一（resolveCategoryShape）单测。
// miniflare 真 D1（同 pipeline.test.ts 模式）：策略表六行逐行断言 + union 双来源取证。
// 管理扩展轮 Task 7（spec-27 裁决 R4）：pruneOrphanCategories 退场，第二段 describe 为退场断言。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFileSync } from 'node:fs';
import { resolveCategoryShape, categoryShapePairs } from '../src/category';
import { insertSite, deleteSite, upsertCategory, allCategories } from '../src/db';
import { buildWebstackYml } from '../src/yml';
import type { SiteRow, CategoryRow } from '../src/types';

const mf = new Miniflare({ log: new Log(LogLevel.ERROR), modules: true, script: 'export default{}', d1Databases: ['DB'], d1Persist: false });
let db: any;
beforeAll(async () => {
  db = await mf.getD1Database('DB');
  await db.exec(readFileSync('schema.sql', 'utf8').replace(/--.*$/gm, '').replace(/\s+/g, ' '));
});
afterAll(async () => { await mf.dispose(); });

const site = (taxonomy: string, term: string, status = 'published') =>
  insertSite(db, {
    url: `https://shape-${taxonomy}-${term || 'empty'}.test/`, url_raw: 'r', title: 't', description: '', logo: '',
    taxonomy, term, status, source: 'manual', sort: 0,
  });

describe('resolveCategoryShape：策略表逐行', () => {
  it('未知分类（categories∪sites 均无行）→ 原样（新分类可自带子结构）', async () => {
    expect(await resolveCategoryShape(db, '全新类', '任意子')).toEqual({ taxonomy: '全新类', term: '任意子' });
    expect(await resolveCategoryShape(db, '全新类', '')).toEqual({ taxonomy: '全新类', term: '' });
    // resolve 只读判定，不落库
    expect((await allCategories(db)).some((c: any) => c.taxonomy === '全新类')).toBe(false);
  });

  it('flat + 非空 term → term 置 空（垃圾子分类静默丢弃，保住分类本身）', async () => {
    await site('常用推荐FL', '');
    await upsertCategory(db, { taxonomy: '常用推荐FL', term: '' });
    expect(await resolveCategoryShape(db, '常用推荐FL', '111')).toEqual({ taxonomy: '常用推荐FL', term: '' });
  });

  it('flat + 空 term → 原样', async () => {
    await site('FL2', '');
    expect(await resolveCategoryShape(db, 'FL2', '')).toEqual({ taxonomy: 'FL2', term: '' });
  });

  it('嵌套 + 非空 term（已有或全新）→ 原样（新子分类自动新增=用户裁决）', async () => {
    await upsertCategory(db, { taxonomy: '媒体创作NE', term: '剪辑' });
    expect(await resolveCategoryShape(db, '媒体创作NE', '剪辑')).toEqual({ taxonomy: '媒体创作NE', term: '剪辑' });
    expect(await resolveCategoryShape(db, '媒体创作NE', '全新子分类')).toEqual({ taxonomy: '媒体创作NE', term: '全新子分类' });
  });

  it('嵌套 + 空 term → term := 未分组（确定性兜底子分类）', async () => {
    await upsertCategory(db, { taxonomy: 'NE2', term: '子甲' });
    expect(await resolveCategoryShape(db, 'NE2', '')).toEqual({ taxonomy: 'NE2', term: '未分组' });
  });

  it('混用（历史脏数据）按嵌套处理：空→未分组；非空原样', async () => {
    await site('MIX', '');                       // sites 侧空 term 行
    await upsertCategory(db, { taxonomy: 'MIX', term: '子乙' }); // categories 侧非空行
    expect(await resolveCategoryShape(db, 'MIX', '')).toEqual({ taxonomy: 'MIX', term: '未分组' });
    expect(await resolveCategoryShape(db, 'MIX', '子乙')).toEqual({ taxonomy: 'MIX', term: '子乙' });
    expect(await resolveCategoryShape(db, 'MIX', '新子')).toEqual({ taxonomy: 'MIX', term: '新子' });
  });

  it('形态取证 = categories ∪ sites（任意 status）：仅 pending 站点也算嵌套证据', async () => {
    await site('PENDONLY', '子任', 'pending'); // 无 categories 行
    expect(await resolveCategoryShape(db, 'PENDONLY', '')).toEqual({ taxonomy: 'PENDONLY', term: '未分组' });
    // 仅 categories 行（无站点）也算 flat 证据
    await upsertCategory(db, { taxonomy: 'CATONLY', term: '' });
    expect(await resolveCategoryShape(db, 'CATONLY', '垃圾子')).toEqual({ taxonomy: 'CATONLY', term: '' });
  });

  it('categoryShapePairs 返回 union 去重对（含两源）', async () => {
    const pairs = await categoryShapePairs(db);
    const set = new Set(pairs.map((p) => `${p.taxonomy}\u0000${p.term}`));
    expect(set.has('MIX\u0000')).toBe(true);        // 来自 sites
    expect(set.has('MIX\u0000子乙')).toBe(true);     // 来自 categories
    expect(set.has('PENDONLY\u0000子任')).toBe(true); // 来自 sites(pending)
    // DISTINCT：同对不重复（MIX,'' 在两源可能同现时仍只一条）
    const dupCount = pairs.filter((p) => p.taxonomy === 'MIX' && p.term === '').length;
    expect(dupCount).toBe(1);
  });
});

describe('prune 退场（spec-27 裁决 R4）：categories 行是站点删除的旁观者，只增不自动删', () => {
  it('category 模块不再导出 pruneOrphanCategories（调用点全部撤除后函数本体退场）', async () => {
    const mod = await import('../src/category');
    expect('pruneOrphanCategories' in mod).toBe(false);
  });

  it('删掉 pair 的最后一个站点行后 categories 行仍在——非空 term 孤儿与 header 行一视同仁保留', async () => {
    // 旧语义：无站点支撑的非空 term 行会被 prune 杀掉；R4 后 categories 行升为一等公民（手动新建的空
    // 分类不得被误杀），原「term=\'\' header 豁免」裁决随 prune 一起失效——因为什么都不自动删了。
    const s1 = await site('退场', '子K');
    await upsertCategory(db, { taxonomy: '退场', term: '子K' }); // 有站点支撑的行
    await upsertCategory(db, { taxonomy: '退场', term: '孤儿' }); // 从未有站点支撑
    await upsertCategory(db, { taxonomy: '退场', term: '' });     // 旧语义的「豁免」行
    const s2 = await site('退场', '');
    await deleteSite(db, s1.id);
    await deleteSite(db, s2.id);
    const cats = (await allCategories(db)).filter((c: any) => c.taxonomy === '退场');
    expect(cats.map((c: any) => c.term).sort()).toEqual(['', '孤儿', '子K'].sort()); // 一行不少
  });

  it('builder 对空组容忍：某分类站点全删（categories 行俱在）→ buildWebstackYml 不抛、空组无 links', () => {
    // 空壳分类保留后发布链路必须无害（spec-27 R4 代价条款）：站点行为分组驱动，零站点的分类
    // 照常输出 taxonomy/icon 骨架但没有任何 links 条目。
    const rows: SiteRow[] = []; // 纯函数入参：站点侧零行（真实库中更早 describe 沉淀了混用脏态，不适合整库导出）
    const cats: CategoryRow[] = [{ taxonomy: '空组', term: '', icon: 'fas fa-folder-open fa-lg', sort: 0 }, { taxonomy: '空组', term: '子Q', icon: 'x', sort: 0 }];
    const text = buildWebstackYml(rows, cats);
    expect(text).toContain('空组');
    expect(text).not.toContain('links:');
  });
});
