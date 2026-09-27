// Task 9 全局验收闸口：真实 data/webstack.yml（1555 行 / 381 条）→ seed.sql → miniflare D1 灌库
// → allPublishedRows/allCategories 读回 → buildWebstackYml 导出 → 与原文件语义深比较（零漂移）。
// 断言不裁剪、不过滤：这是发布不变式的最终证据。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { describe, it, expect, beforeAll } from 'vitest';
import * as seed from '../scripts/seed.mjs';
import { generateSeedSql } from '../scripts/seed.mjs';
import { buildWebstackYml, buildFriendlinksYml, buildNavYml } from '../src/yml';
import { allPublishedRows, allCategories, allFriendlinks, allNavitems } from '../src/db';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // admin/
const REAL_YML = readFileSync(`${ROOT}../data/webstack.yml`, 'utf8');
const REAL_FL = readFileSync(`${ROOT}../data/friendlinks.yml`, 'utf8');
const REAL_HEADERS = readFileSync(`${ROOT}../data/headers.yml`, 'utf8');

describe('seed 不变式闸口（真实 webstack.yml 全量 round-trip）', () => {
  let sql;
  let db;

  beforeAll(async () => {
    sql = generateSeedSql(REAL_YML, REAL_FL, REAL_HEADERS);
    // 与已提交的生成物逐字节一致（npm run seed 幂等确定性）
    expect(sql).toBe(readFileSync(`${ROOT}seed.sql`, 'utf8'));
    const mf = new Miniflare({
      log: new Log(LogLevel.ERROR),
      modules: true,
      script: 'export default{}',
      d1Databases: ['DB'],
      d1Persist: false,
    });
    db = await mf.getD1Database('DB');
    // 同 pipeline.test.ts：压平 schema.sql 为单行语句；seed.sql 本身每条即单行
    await db.exec(readFileSync(`${ROOT}schema.sql`, 'utf8').replace(/--.*$/gm, '').replace(/\s+/g, ' '));
    await db.exec(sql);
  }, 60_000);

  it('站点与分类行数符合预期（381 条 / 14 个分类行）', async () => {
    const rows = await allPublishedRows(db);
    const cats = await allCategories(db);
    expect(rows.length).toBe(381);
    expect(cats.length).toBe(14); // 2 个 taxonomy 级 + 12 个 term 级
    expect(rows.every((r) => r.status === 'published' && r.source === 'seed')).toBe(true);
  });

  it('D1 读回 → 序列化 → yaml.load 深比较：与真实文件零漂移（闸口）', async () => {
    const rows = await allPublishedRows(db);
    const cats = await allCategories(db);
    const rebuilt = yaml.load(buildWebstackYml(rows, cats));
    expect(rebuilt).toEqual(yaml.load(REAL_YML));
  });

  it('导出与原文件逐字节一致（曾有的 7 行引号风格差异已被 2026-09-27 后台发布 commit 45847f6 归一，现为零漂移）', async () => {
    const rows = await allPublishedRows(db);
    const cats = await allCategories(db);
    const out = buildWebstackYml(rows, cats);
    expect(out).toBe(REAL_YML);
  });

  it('url 列为规范化去重键（seed 行含 url_raw 原样；重复 url 以 #seed-dup-N 后缀保唯一）', async () => {
    const rows = await allPublishedRows(db);
    expect(rows.every((r) => r.url_raw && r.url !== '' )).toBe(true);
    const dups = rows.filter((r) => /#seed-dup-\d+$/.test(r.url));
    expect(dups.length).toBe(3); // 3 条真实重复 URL 的第 2 次出现
    // 重复对的 url_raw 与首现行一致（数据保真，仅 dedup 键让位）
    for (const d of dups) {
      expect(rows.some((r) => r.id !== d.id && r.url_raw === d.url_raw && !/#seed-dup/.test(r.url))).toBe(true);
    }
  });

  // ── 管理扩展 Task 3：friendlinks / navitems 三表化 + 语义 round-trip 闸口 ──

  it('friendlinks/headers 语义 round-trip：seed 行经 builder 重建 ≡ 源文件（js-yaml 解析 deep-equal，含序）', async () => {
    const flRows = await allFriendlinks(db);
    const navRows = await allNavitems(db);
    expect(flRows.length).toBe(8); // data/friendlinks.yml 全量
    expect(navRows.length).toBe(17); // data/headers.yml：9 顶层 + 8 子项（子项全部挂「更多」）
    expect(yaml.load(buildFriendlinksYml(flRows))).toEqual(yaml.load(REAL_FL));
    expect(yaml.load(buildNavYml(navRows))).toEqual(yaml.load(REAL_HEADERS));
    // 控制器便签①：「更多」纯下拉容器的 link 空串经 INSERT→D1→SELECT→builder 全链路保真
    const more = navRows.find((r) => r.item === '更多');
    expect(more.link).toBe('');
    // 控制器便签②：8 个子项共享同一父「更多」，(sort,id) 双升序钉住文件序
    const kids = navRows.filter((r) => r.parent_id !== null);
    expect(kids.length).toBe(8);
    expect(kids.every((r) => r.parent_id === more.id)).toBe(true);
    expect(kids.map((r) => r.sort)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(kids.map((r) => r.id)).toEqual([...kids.map((r) => r.id)].sort((a, b) => a - b));
  });

  it('flattenCollections 共享行集：显式 id（友链 1..n；导航顶层 1..n、子项接号且 parent 前置）', () => {
    const { flinks, navs } = seed.flattenCollections(REAL_FL, REAL_HEADERS);
    expect(flinks).toEqual(
      yaml.load(REAL_FL).map((r, i) => ({ title: r.title, url: r.url, description: r.description, sort: i }))
    );
    expect(navs.length).toBe(17);
    const tops = navs.filter((r) => r.parent_id === null);
    expect(tops.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(tops.map((r) => r.sort)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // 行集自序 = 先父后子：每个子项出现时其 parent 必已在前（parent_id < id 且指向顶层行）
    const kids = navs.filter((r) => r.parent_id !== null);
    expect(kids.map((r) => r.id)).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
    for (const k of kids) {
      const parent = navs.find((r) => r.id === k.parent_id);
      expect(parent && parent.parent_id).toBe(null);
      expect(navs.indexOf(parent)).toBeLessThan(navs.indexOf(k));
    }
  });

  it('seed.sql 结构：四表 DELETE 首行；friendlinks 单语句；navitems 先父后子两语句；每语句严格单行', () => {
    const lines = sql.trimEnd().split('\n');
    expect(lines[0]).toBe('DELETE FROM sites; DELETE FROM categories; DELETE FROM friendlinks; DELETE FROM navitems;');
    expect(lines.every((l) => /;$/.test(l))).toBe(true); // miniflare db.exec 按换行切分：一条语句一行
    const flLines = lines.filter((l) => l.startsWith('INSERT INTO friendlinks '));
    expect(flLines.length).toBe(1);
    expect(flLines[0]).toContain(`INSERT INTO friendlinks (id, title, url, description, sort) VALUES (1, 'NOISE宝藏阁', 'https://noisevip.cn', '综合资源收录站', 0),`);
    const navLines = lines.filter((l) => l.startsWith('INSERT INTO navitems '));
    expect(navLines.length).toBe(2); // 先父后子两语句（无 FK 约束，顺序习惯）
    expect(navLines[0]).toContain(`(9, '更多', 'fa fa-map-signs', '', NULL, 8)`); // 空 link 走查
    expect(navLines[0]).not.toContain(`(10, `);
    expect(navLines[1]).toContain(`(10, '😀Emoji', '', './assets/emoji/', 9, 0)`); // 子项引用先行父 id
  });

  it('兼容：friendlinks/headers 参数缺省时不生成两新表语句（webstack 381 行闸口原样成立）', () => {
    const legacy = generateSeedSql(REAL_YML);
    expect(legacy).not.toContain('INSERT INTO friendlinks');
    expect(legacy).not.toContain('INSERT INTO navitems');
    expect(legacy.trimEnd().split('\n').length).toBe(sql.trimEnd().split('\n').length - 3); // 缺省版少：1 友链 + 2 导航语句
    expect(legacy).toContain('DELETE FROM friendlinks; DELETE FROM navitems;'); // DELETE 恒四表，重放清空
    // 站点/分类部分与三参版逐字节一致（新表语句纯追加，旧块零漂移）
    expect(sql.startsWith(legacy.slice(0, legacy.indexOf('INSERT INTO sites')))).toBe(true);
  });
});
