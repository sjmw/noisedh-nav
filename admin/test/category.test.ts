// 冒烟修复轮：分类形态归一（resolveCategoryShape）与孤儿清理（pruneOrphanCategories）单测。
// miniflare 真 D1（同 pipeline.test.ts 模式）：策略表六行逐行断言 + union 双来源取证。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFileSync } from 'node:fs';
import { resolveCategoryShape, categoryShapePairs, pruneOrphanCategories } from '../src/category';
import { insertSite, upsertCategory, allCategories } from '../src/db';

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

describe('pruneOrphanCategories：删除无站点支撑的 categories 行', () => {
  it('精确 (taxonomy,term) 无 sites 行 → 删；有 → 留；顺带清 未分类 空壳', async () => {
    await site('K', '');
    await site('K', '子K');
    await upsertCategory(db, { taxonomy: 'K', term: '' });
    await upsertCategory(db, { taxonomy: 'K', term: '子K' });
    await upsertCategory(db, { taxonomy: 'K', term: '孤儿' });
    await upsertCategory(db, { taxonomy: '未分类', term: '' }); // 现存的降级空壳（无站点）
    await pruneOrphanCategories(db);
    const cats = await allCategories(db);
    expect(cats.filter((c: any) => c.taxonomy === 'K').map((c: any) => c.term).sort()).toEqual(['', '子K']);
    expect(cats.some((c: any) => c.taxonomy === '未分类')).toBe(false);
  });
});
