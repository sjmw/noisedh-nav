// Task 9 seed 生成器（Node 本地脚本，可依赖 js-yaml；与 src/ 的零运行时依赖约束隔离）
// 仓库根 data/webstack.yml + data/friendlinks.yml + data/headers.yml（管理扩展 Task 3 三表化）
//   → admin/seed.sql：DELETE 后全量 INSERT，source='seed'、status='published'。
// 裁定记录（详见 test/seed.test.mjs 闸口断言）：
//  (a) sites.url 存 normalizeUrl 结果（去重键），url_raw 存原样；发布导出走 url_raw（见 src/yml.ts）。
//  (b) 真实文件中 3 个 URL 各出现两次（不同条目、同一规范化键）：UNIQUE(url) 只容首现行，
//      第 2..n 次出现的 url 追加 '#seed-dup-N' 片段后缀保唯一；url_raw 仍为原样，导出不受影响。
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
// Node ≥23.6 原生 type-stripping，直接消费 src/url.ts 的同一实现（无副本漂移风险）
import { normalizeUrl } from '../src/url.ts';

const sqlQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/** 展平 yml（直挂 links / 嵌套 list[{term,links}] 两形态）→ sites 行与 categories 行 */
export function flattenWebstack(ymlText) {
  const doc = yaml.load(ymlText);
  if (!Array.isArray(doc)) throw new Error('webstack.yml 顶层必须是数组');
  const sites = [];
  const cats = [];
  const seen = new Map(); // normalized url -> 出现次数（重复键裁定 (b) 的计数）
  doc.forEach((t, ti) => {
    if (!t || typeof t.taxonomy !== 'string') throw new Error(`第 ${ti} 个 taxonomy 节点缺少名称`);
    cats.push({ taxonomy: t.taxonomy, term: '', icon: t.icon ?? '', sort: ti });
    const groups = t.links ? [{ term: '', links: t.links }] : (t.list ?? []);
    groups.forEach((g, gi) => {
      const term = g.term ?? '';
      // term 级在源文件中无 icon 字段（仅 term/links 两键）；导出只读 taxonomy 级 icon，故置 ''
      if (term) cats.push({ taxonomy: t.taxonomy, term, icon: '', sort: gi });
      (g.links ?? []).forEach((l) => {
        const norm = normalizeUrl(l.url);
        if (norm === null) throw new Error(`URL 无法规范化：${JSON.stringify(l.url)}（title=${l.title}）`);
        const n = (seen.get(norm) ?? 0) + 1;
        seen.set(norm, n);
        sites.push({
          url: n === 1 ? norm : `${norm}#seed-dup-${n}`,
          url_raw: l.url,
          title: l.title ?? '',
          description: l.description ?? '',
          logo: l.logo ?? '',
          taxonomy: t.taxonomy,
          term,
          sort: (g.links ?? []).indexOf(l), // 组内原序（数据无重复对象引用，indexOf 安全）
        });
      });
    });
  });
  return { sites, cats };
}

/**
 * 管理扩展轮（Task 3）：data/friendlinks.yml + data/headers.yml → friendlinks/navitems 行集。
 * 显式 id 按文件序分配（友链 1..n；导航顶层 1..n、子项从 n+1 起接号），
 * 使子项 parent_id 引用稳定且「先父后子」——SQL 与测试共用本行集，不靠解析 SQL。
 */
export function flattenCollections(friendlinksText, headersText) {
  const flinks = [];
  if (friendlinksText && friendlinksText.trim()) {
    const doc = yaml.load(friendlinksText);
    if (!Array.isArray(doc)) throw new Error('friendlinks.yml 顶层必须是数组');
    doc.forEach((r, i) => {
      if (!r || typeof r.title !== 'string') throw new Error(`friendlinks 第 ${i} 项缺少 title`);
      flinks.push({ title: r.title, url: r.url ?? '', description: r.description ?? '', sort: i });
    });
  }
  const navs = [];
  if (headersText && headersText.trim()) {
    const doc = yaml.load(headersText);
    if (!Array.isArray(doc)) throw new Error('headers.yml 顶层必须是数组');
    doc.forEach((t, ti) => {
      if (!t || typeof t.item !== 'string') throw new Error(`headers 第 ${ti} 项缺少 item`);
      // 空 link 是「更多」纯下拉容器的现状形状（见 src/yml.ts buildNavYml 注释），原样保留
      navs.push({ id: ti + 1, item: t.item, icon: t.icon ?? '', link: t.link ?? '', parent_id: null, sort: ti });
    });
    let next = doc.length + 1; // 子项从顶层之后接号；两趟循环保证全部父先于子入集
    doc.forEach((t, ti) => {
      (t.list ?? []).forEach((k, ki) => {
        if (!k || typeof k.name !== 'string') throw new Error(`headers「${t.item}」第 ${ki} 个子项缺少 name`);
        navs.push({ id: next++, item: k.name, icon: '', link: k.url ?? '', parent_id: ti + 1, sort: ki });
      });
    });
  }
  return { flinks, navs };
}

/** 生成完整 seed.sql 文本（每条语句严格单行——miniflare db.exec 按换行切分） */
export function generateSeedSql(ymlText, friendlinksText = '', headersText = '') {
  const { sites, cats } = flattenWebstack(ymlText);
  const { flinks, navs } = flattenCollections(friendlinksText, headersText);
  const lines = ['DELETE FROM sites; DELETE FROM categories; DELETE FROM friendlinks; DELETE FROM navitems;'];
  lines.push(
    `INSERT INTO categories (taxonomy, term, icon, sort) VALUES ${cats
      .map((c) => `(${sqlQuote(c.taxonomy)}, ${sqlQuote(c.term)}, ${sqlQuote(c.icon)}, ${c.sort})`)
      .join(', ')};`
  );
  // 站点行按 (taxonomy, term) 组分块 INSERT：组即导出分组，块内 VALUES 顺序=id 顺序=原序
  const COLS = '(url, url_raw, title, description, logo, taxonomy, term, status, source, sort)';
  let key = null;
  let vals = [];
  const flush = () => {
    if (vals.length) lines.push(`INSERT INTO sites ${COLS} VALUES ${vals.join(', ')};`);
    vals = [];
  };
  for (const s of sites) {
    const k = `${s.taxonomy}\u0000${s.term}`;
    if (k !== key) {
      flush();
      key = k;
    }
    vals.push(
      `(${sqlQuote(s.url)}, ${sqlQuote(s.url_raw)}, ${sqlQuote(s.title)}, ${sqlQuote(s.description)}, ${sqlQuote(s.logo)}, ${sqlQuote(s.taxonomy)}, ${sqlQuote(s.term)}, 'published', 'seed', ${s.sort})`
    );
  }
  flush();
  if (flinks.length)
    lines.push(`INSERT INTO friendlinks (id, title, url, description, sort) VALUES ${flinks.map((r, i) => `(${i + 1}, ${sqlQuote(r.title)}, ${sqlQuote(r.url)}, ${sqlQuote(r.description)}, ${i})`).join(', ')};`);
  // navitems：顶层 id 1..n，子项从 n+1 起；两语句（先父后子）保证外键语义（无 FK 约束，仅顺序习惯）
  const navCols = '(id, item, icon, link, parent_id, sort)';
  const navVal = (r) => `(${r.id}, ${sqlQuote(r.item)}, ${sqlQuote(r.icon)}, ${sqlQuote(r.link)}, ${r.parent_id === null ? 'NULL' : r.parent_id}, ${r.sort})`;
  const navTops = navs.filter((r) => r.parent_id === null);
  const navKids = navs.filter((r) => r.parent_id !== null);
  if (navTops.length) lines.push(`INSERT INTO navitems ${navCols} VALUES ${navTops.map(navVal).join(', ')};`);
  if (navKids.length) lines.push(`INSERT INTO navitems ${navCols} VALUES ${navKids.map(navVal).join(', ')};`);
  return lines.join('\n') + '\n';
}

// 作为主程序运行（npm run seed）：读仓库根 data/ 三个真实 yml，写 admin/seed.sql
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const yml = readFileSync(new URL('../../data/webstack.yml', import.meta.url), 'utf8');
  const fl = readFileSync(new URL('../../data/friendlinks.yml', import.meta.url), 'utf8');
  const headers = readFileSync(new URL('../../data/headers.yml', import.meta.url), 'utf8');
  const out = generateSeedSql(yml, fl, headers);
  writeFileSync(new URL('../seed.sql', import.meta.url), out);
  const { sites, cats } = flattenWebstack(yml);
  const { flinks, navs } = flattenCollections(fl, headers);
  console.log(
    `seed.sql 已生成：${sites.length} 站点行 / ${cats.length} 分类行 / ${flinks.length} 友链行 / ${navs.length} 导航行（${navs.filter((r) => r.parent_id === null).length} 顶 + ${navs.length - navs.filter((r) => r.parent_id === null).length} 子）`
  );
}
