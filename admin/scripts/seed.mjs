// Task 9 seed 生成器（Node 本地脚本，可依赖 js-yaml；与 src/ 的零运行时依赖约束隔离）
// 仓库根 data/webstack.yml → admin/seed.sql：DELETE 后全量 INSERT，source='seed'、status='published'。
// 裁定记录（详见 task-9-report.md）：
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

/** 生成完整 seed.sql 文本（每条语句严格单行——miniflare db.exec 按换行切分） */
export function generateSeedSql(ymlText) {
  const { sites, cats } = flattenWebstack(ymlText);
  const lines = ['DELETE FROM sites; DELETE FROM categories;'];
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
  return lines.join('\n') + '\n';
}

// 作为主程序运行（npm run seed）：读真实 yml，写 admin/seed.sql
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const yml = readFileSync(new URL('../../data/webstack.yml', import.meta.url), 'utf8');
  const out = generateSeedSql(yml);
  writeFileSync(new URL('../seed.sql', import.meta.url), out);
  const { sites } = flattenWebstack(yml);
  console.log(`seed.sql 已生成：${sites.length} 个站点行`);
}
