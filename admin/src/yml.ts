import type { SiteRow, CategoryRow } from './types';

// 转义：仅当字符串含 ": "、" #"（YAML 注释仅在空白后起始；词中 '#' 如 URL 片段无需引号）、
// 首尾空格、空串、以 YAML 特殊字符开头（含行首 #）或以 : 结尾时用双引号
const LEAD_SPECIAL = /^[-?:,[\]{}#&*!|>'"%@`]/;
const q = (s: string): string =>
  s === '' || s.includes(': ') || / #/.test(s) || /:$/u.test(s) || /^\s|\s$/.test(s) || LEAD_SPECIAL.test(s)
    ? JSON.stringify(s)
    : s;

const byOrder = (a: SiteRow, b: SiteRow): number => a.sort - b.sort || a.id - b.id;

/** 生成与 data/webstack.yml 语义一致的 yml 文本：D1 行 → 两种形态（直挂 links / list[{term,links}]） */
export function buildWebstackYml(sites: SiteRow[], categories: CategoryRow[]): string {
  const rows = sites.filter((s) => s.status === 'published');

  // 顶层 taxonomy 顺序与 icon：来自 term 为空的分类行（按 sort）
  const taxonomies: string[] = [];
  const iconOf = new Map<string, string>();
  // 各 taxonomy 下 term 顺序：来自 term 非空的分类行（按 sort）
  const termsOf = new Map<string, string[]>();
  for (const c of [...categories].sort((a, b) => a.sort - b.sort)) {
    if (c.term === '') {
      if (!iconOf.has(c.taxonomy)) {
        taxonomies.push(c.taxonomy);
        iconOf.set(c.taxonomy, c.icon);
      }
    } else {
      let arr = termsOf.get(c.taxonomy);
      if (!arr) termsOf.set(c.taxonomy, (arr = []));
      if (!arr.includes(c.term)) arr.push(c.term);
    }
  }

  // 站点行按 taxonomy+term 分组
  const grouped = new Map<string, SiteRow[]>();
  for (const r of rows) {
    const key = `${r.taxonomy}\u0000${r.term}`;
    const arr = grouped.get(key);
    if (arr) arr.push(r);
    else grouped.set(key, [r]);
  }
  //  categories 未覆盖的 taxonomy/term 兜底追加
  for (const r of rows) {
    if (!taxonomies.includes(r.taxonomy)) taxonomies.push(r.taxonomy);
    if (r.term) {
      let arr = termsOf.get(r.taxonomy);
      if (!arr) termsOf.set(r.taxonomy, (arr = []));
      if (!arr.includes(r.term)) arr.push(r.term);
    }
  }

  const siteLines = (list: SiteRow[], pad: string): string[] =>
    [...list]
      .sort(byOrder)
      .flatMap((r) => {
        const out = [`${pad}- title: ${q(r.title)}`];
        if (r.logo) out.push(`${pad}  logo: ${q(r.logo)}`);
        // Task 9 裁定(a)：导出原样 url_raw（人工维护的 URL 字节保真，
        // 如末尾 '/'），url 仅作规范化去重键。既有行 url_raw 缺省时回退 url。
        out.push(`${pad}  url: ${q(r.url_raw || r.url)}`);
        if (r.description) out.push(`${pad}  description: ${q(r.description)}`);
        return out;
      });

  const lines: string[] = ['---'];
  for (const tax of taxonomies) {
    lines.push(`- taxonomy: ${q(tax)}`);
    const icon = iconOf.get(tax) ?? '';
    if (icon) lines.push(`  icon: ${q(icon)}`);
    const terms = termsOf.get(tax) ?? [];
    const directList = grouped.get(`${tax}\u0000`) ?? [];
    if (terms.length > 0 && directList.length > 0) {
      throw new Error(`taxonomy「${tax}」混用了空 term 与非空 term 数据，无法确定输出形态，请先修正数据`);
    }
    if (terms.length === 0) {
      // 直挂形态
      if (directList.length) lines.push('  links:', ...siteLines(directList, '    '));
    } else {
      // 嵌套形态
      lines.push('  list:');
      for (const term of terms) {
        lines.push(`    - term: ${q(term)}`);
        const list = grouped.get(`${tax}\u0000${term}`) ?? [];
        if (list.length) lines.push('      links:', ...siteLines(list, '        '));
      }
    }
  }
  return lines.join('\n') + '\n';
}

// 管理扩展轮（spec-27 §4）：friendlinks.yml / headers.yml 与 webstack 同纪律——确定性生成、同输入同字节。
import type { FriendlinkRow, NavitemRow } from './types';
export function buildFriendlinksYml(rows: FriendlinkRow[]): string {
  const sorted = [...rows].sort((a, b) => a.sort - b.sort || a.id - b.id);
  if (!sorted.length) return '[]\n';
  const lines: string[] = [];
  for (const r of sorted) {
    lines.push(`- title: ${q(r.title)}`, `  url: ${q(r.url)}`);
    if (r.description) lines.push(`  description: ${q(r.description)}`);
  }
  return lines.join('\n') + '\n';
}
export function buildNavYml(rows: NavitemRow[]): string {
  const tops = rows.filter((r) => r.parent_id === null).sort((a, b) => a.sort - b.sort || a.id - b.id);
  if (!tops.length) return '[]\n';
  const kids = new Map<number, NavitemRow[]>();
  for (const r of rows) if (r.parent_id !== null) (kids.get(r.parent_id) ?? kids.set(r.parent_id, []).get(r.parent_id)!).push(r);
  const lines: string[] = [];
  for (const t of tops) {
    lines.push(`- item: ${q(t.item)}`);
    if (t.icon) lines.push(`  icon: ${q(t.icon)}`);
    lines.push(`  link: ${q(t.link)}`); // 空串显式输出（「更多」纯下拉容器的现状形状）
    const kidList = (kids.get(t.id) ?? []).sort((a, b) => a.sort - b.sort || a.id - b.id);
    if (kidList.length) {
      lines.push('  list:');
      for (const k of kidList) lines.push(`    - name: ${q(k.item)}`, `      url: ${q(k.link)}`);
    }
  }
  return lines.join('\n') + '\n';
}
