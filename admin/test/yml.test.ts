import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { describe, it, expect } from 'vitest';
import { buildWebstackYml } from '../src/yml';
import type { SiteRow, CategoryRow } from '../src/types';
const FIX = 'test/fixtures/webstack.sample.yml';
const row = (o: Partial<SiteRow>): SiteRow => ({ id: 0, url: o.url!, url_raw: o.url_raw ?? o.url!, title: o.title!, description: o.description ?? '', logo: o.logo ?? '', taxonomy: o.taxonomy!, term: o.term ?? '', status: 'published', source: 'seed', sort: o.sort ?? 0, created_at: '', updated_at: '' });
describe('buildWebstackYml 不变式', () => {
  it('fixture 导入→导出语义相等', () => {
    const orig = yaml.load(readFileSync(FIX, 'utf8')) as any[];
    // 展平 fixture 成行（直挂与嵌套两种形态都处理）
    const rows: SiteRow[] = []; const cats: CategoryRow[] = [];
    orig.forEach((t, ti) => {
      cats.push({ taxonomy: t.taxonomy, term: '', icon: t.icon, sort: ti });
      const groups = t.links ? [{ term: '', links: t.links }] : t.list;
      groups.forEach((g: any, gi: number) => {
        if (g.term) cats.push({ taxonomy: t.taxonomy, term: g.term, icon: '', sort: gi });
        g.links.forEach((l: any, li: number) =>
          rows.push(row({ url: l.url, title: l.title, description: l.description, logo: l.logo, taxonomy: t.taxonomy, term: g.term || '', sort: li })));
      });
    });
    const rebuilt = yaml.load(buildWebstackYml(rows, cats)) as any[];
    expect(rebuilt).toEqual(orig);
    // 字节级一致：锁定键序/缩进/转义，为 Task 9 发布闸口兜底
    expect(buildWebstackYml(rows, cats)).toBe(readFileSync(FIX, 'utf8'));
  });
  it('冒号/井号标题被正确转义', () => {
    const out = buildWebstackYml([row({ url: 'https://a', title: 'B: C #1', taxonomy: 'T' })], [{ taxonomy: 'T', term: '', icon: 'i', sort: 0 }]);
    expect((yaml.load(out) as any[])[0].links[0].title).toBe('B: C #1');
  });
  it('以冒号结尾的标题被加引号并可回读', () => {
    const out = buildWebstackYml([row({ url: 'https://a', title: '注意:', taxonomy: 'T' })], [{ taxonomy: 'T', term: '', icon: 'i', sort: 0 }]);
    expect((yaml.load(out) as any[])[0].links[0].title).toBe('注意:');
  });
  it('同一 taxonomy 混用空 term 与非空 term 时 fail-fast 抛错', () => {
    const sites = [
      row({ url: 'https://a', title: 'A', taxonomy: 'T', term: '' }),
      row({ url: 'https://b', title: 'B', taxonomy: 'T', term: '子项' }),
    ];
    const cats = [
      { taxonomy: 'T', term: '', icon: 'i', sort: 0 },
      { taxonomy: 'T', term: '子项', icon: '', sort: 1 },
    ];
    expect(() => buildWebstackYml(sites, cats)).toThrow(/混用/);
  });
});
