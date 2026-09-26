// D1 访问助手：全部单语句（无多语句拼接），写语句统一带 updated_at=datetime('now')（sites 表）。
// db 参数由 Worker 注入（env.DB），本模块零 npm 运行时依赖，仅类型引用 @cloudflare/workers-types。

import type { SiteRow, CategoryRow } from './types';

export async function getSiteByUrl(db: D1Database, url: string): Promise<SiteRow | null> {
  return (await db.prepare('SELECT * FROM sites WHERE url = ?').bind(url).first<SiteRow>()) ?? null;
}

export async function insertSite(db: D1Database, row: Omit<SiteRow, 'id' | 'created_at' | 'updated_at'>): Promise<SiteRow> {
  const inserted = await db
    .prepare(`INSERT INTO sites (url, url_raw, title, description, logo, taxonomy, term, status, source, sort)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .bind(row.url, row.url_raw, row.title, row.description, row.logo, row.taxonomy, row.term, row.status, row.source, row.sort)
    .first<SiteRow>();
  if (!inserted) throw new Error('insertSite: RETURNING 行缺失');
  return inserted;
}

// 可改字段白名单：id/created_at/updated_at 不可经 patch 设置
const MUTABLE = ['url', 'url_raw', 'title', 'description', 'logo', 'taxonomy', 'term', 'status', 'source', 'sort'] as const;
export type SitePatch = Partial<Pick<SiteRow, (typeof MUTABLE)[number]>>;

export async function updateSite(db: D1Database, id: number, patch: SitePatch): Promise<SiteRow | null> {
  const keys = MUTABLE.filter((k) => patch[k] !== undefined);
  const sets = [...keys.map((k) => `${k} = ?`), `updated_at = datetime('now')`].join(', ');
  const vals = keys.map((k) => patch[k] as never);
  return (await db.prepare(`UPDATE sites SET ${sets} WHERE id = ? RETURNING *`).bind(...vals, id).first<SiteRow>()) ?? null;
}

export async function deleteSite(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM sites WHERE id = ?').bind(id).run();
}

export interface ListOpts {
  status?: string;
  taxonomy?: string;
  q?: string;     // 对 title/url/description 做 LIKE 包含匹配（通配符按字面量转义）
  page?: number;  // 默认 1
  perPage?: number; // 默认 50，上限 200
}

export async function listSites(db: D1Database, opts: ListOpts = {}): Promise<{ rows: SiteRow[]; total: number }> {
  const where: string[] = [];
  const vals: (string | number)[] = [];
  if (opts.status) { where.push('status = ?'); vals.push(opts.status); }
  if (opts.taxonomy) { where.push('taxonomy = ?'); vals.push(opts.taxonomy); }
  if (opts.q) {
    const like = `%${opts.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    where.push(`(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`);
    vals.push(like, like, like);
  }
  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const perPage = Math.min(200, Math.max(1, Math.trunc(opts.perPage ?? 50)));
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM sites${w}`).bind(...vals).first<{ n: number }>())?.n ?? 0;
  const { results } = await db
    .prepare(`SELECT * FROM sites${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...vals, perPage, (page - 1) * perPage)
    .all<SiteRow>();
  return { rows: results, total };
}

// 发布导出用：稳定全序（分类 → 子分类 → sort → id），Task 9 的 yml 重建按此顺序消费
export async function allPublishedRows(db: D1Database): Promise<SiteRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM sites WHERE status = 'published' ORDER BY taxonomy, term, sort, id`)
    .all<SiteRow>();
  return results;
}

export async function allCategories(db: D1Database): Promise<CategoryRow[]> {
  const { results } = await db.prepare('SELECT * FROM categories ORDER BY taxonomy, term').all<CategoryRow>();
  return results;
}

// 「补位」语义：已存在则整条忽略（不覆盖 icon/sort，人工管理优先）
export async function upsertCategory(db: D1Database, cat: { taxonomy: string; term?: string; icon?: string; sort?: number }): Promise<void> {
  await db
    .prepare(`INSERT INTO categories (taxonomy, term, icon, sort) VALUES (?, ?, ?, ?)
              ON CONFLICT(taxonomy, term) DO NOTHING`)
    .bind(cat.taxonomy, cat.term ?? '', cat.icon ?? 'fas fa-folder-open fa-lg', cat.sort ?? 0)
    .run();
}
