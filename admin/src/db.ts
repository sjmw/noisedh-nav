// D1 访问助手：全部单语句（无多语句拼接），写语句统一带 updated_at=datetime('now')（sites 表）。
// db 参数由 Worker 注入（env.DB），本模块零 npm 运行时依赖，仅类型引用 @cloudflare/workers-types。

import type { SiteRow, CategoryRow } from './types';

export async function getSiteByUrl(db: D1Database, url: string): Promise<SiteRow | null> {
  return (await db.prepare('SELECT * FROM sites WHERE url = ?').bind(url).first<SiteRow>()) ?? null;
}

export async function getSiteById(db: D1Database, id: number): Promise<SiteRow | null> {
  return (await db.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<SiteRow>()) ?? null;
}

// 扩展兼容层 DELETE-by-title 用：同名多行时取最早 id（追加序=展示序，删旧留新）
export async function findOldestSiteByTitle(db: D1Database, title: string): Promise<SiteRow | null> {
  return (await db.prepare('SELECT * FROM sites WHERE title = ? ORDER BY id LIMIT 1').bind(title).first<SiteRow>()) ?? null;
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

// publish 快照用：与 allPublishedRows 同序（同一全序下拼接两类状态即可复现构建顺序）
export async function allPendingRows(db: D1Database): Promise<SiteRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM sites WHERE status = 'pending' ORDER BY taxonomy, term, sort, id`)
    .all<SiteRow>();
  return results;
}

// 发布成功后的批量翻转（发布即快照）。按本次快照的 id 清单翻转而非 WHERE status='pending'：
// GitHub 往返窗口内新落入的 pending 行不在本次 yml 里，不能被静默连带发布。
// 每批 90 个绑定参数（D1 单语句参数上限 100 的保守值）。
export async function markPendingPublished(db: D1Database, ids: number[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    await db
      .prepare(`UPDATE sites SET status = 'published', updated_at = datetime('now') WHERE status = 'pending' AND id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .run();
  }
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

export async function deleteCategory(db: D1Database, taxonomy: string, term: string): Promise<void> {
  await db.prepare('DELETE FROM categories WHERE taxonomy = ? AND term = ?').bind(taxonomy, term).run();
}
