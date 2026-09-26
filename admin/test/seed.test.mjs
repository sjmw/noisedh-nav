// Task 9 全局验收闸口：真实 data/webstack.yml（1555 行 / 381 条）→ seed.sql → miniflare D1 灌库
// → allPublishedRows/allCategories 读回 → buildWebstackYml 导出 → 与原文件语义深比较（零漂移）。
// 断言不裁剪、不过滤：这是发布不变式的最终证据。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { describe, it, expect, beforeAll } from 'vitest';
import { generateSeedSql } from '../scripts/seed.mjs';
import { buildWebstackYml } from '../src/yml';
import { allPublishedRows, allCategories } from '../src/db';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // admin/
const REAL_YML = readFileSync(`${ROOT}../data/webstack.yml`, 'utf8');

describe('seed 不变式闸口（真实 webstack.yml 全量 round-trip）', () => {
  let sql;
  let db;

  beforeAll(async () => {
    sql = generateSeedSql(REAL_YML);
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

  it('导出与原文件仅存在已知的引号风格差异（7 行单引号 vs 双引号），其余逐字节一致', async () => {
    const rows = await allPublishedRows(db);
    const cats = await allCategories(db);
    const out = buildWebstackYml(rows, cats);
    const a = out.split('\n');
    const b = REAL_YML.split('\n');
    expect(a.length).toBe(b.length);
    let diffLines = 0;
    a.forEach((line, i) => {
      if (line === b[i]) return;
      diffLines++;
      // 差异行必须语义相等且仅是 " → ' 的风格差（人工文件历史写法，序列化器统一双引号）
      expect(yaml.load(line)).toEqual(yaml.load(b[i]));
      expect(line.replace(/"/g, "'")).toBe(b[i]);
    });
    expect(diffLines).toBe(7);
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
});
