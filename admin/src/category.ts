// 冒烟修复轮：分类形态归一（brief 策略表）。
// 形态权威判定 = categories 行 ∪ sites 行（任意 status）中该 taxonomy 的 (taxonomy, term) 集合。
// 三个写入口（pipeline/extension/routes）与 reanalyze 全部复用本模块，杜绝「flat 分类被填垃圾子分类」
// 导致 categories 同现 '' 与非空两形态、发布与 GET /data/webstack.yml 同时被毒化的病灶。
// src/yml.ts 的形态守卫保留为最后防线，不改。

export const UNGROUPED_TERM = '未分组';

export interface ShapePair {
  taxonomy: string;
  term: string;
}

// union 取证：sites 任意 status 都算（pending 行的分类形态也是形态）。DISTINCT 去重（同对可在两源同现）。
export async function categoryShapePairs(db: D1Database): Promise<ShapePair[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT taxonomy, term FROM (SELECT taxonomy, term FROM sites UNION SELECT taxonomy, term FROM categories)`,
    )
    .all<ShapePair>();
  return results;
}

export type TaxonomyShape = 'unknown' | 'flat' | 'nested' | 'mixed';

// 从 union pairs 判定某 taxonomy 既有形态（策略表第一列）。mixed=历史脏数据，消费侧按嵌套处理。
export function shapeOfTaxonomy(pairs: ShapePair[], taxonomy: string): TaxonomyShape {
  let hasEmpty = false;
  let hasNonEmpty = false;
  for (const p of pairs) {
    if (p.taxonomy !== taxonomy) continue;
    if (p.term === '') hasEmpty = true;
    else hasNonEmpty = true;
  }
  if (hasEmpty && hasNonEmpty) return 'mixed';
  if (hasEmpty) return 'flat';
  if (hasNonEmpty) return 'nested';
  return 'unknown';
}

// 策略表（用户已裁决）：
// | 既有形态                              | 传入 term | 结果        |
// | 未知（两源均无行）                    | 任意      | 原样        |
// | flat（仅 '' 行）                      | 非空      | term 置 ''  |
// | flat                                  | 空        | 原样        |
// | 嵌套（存在非空 term 行）              | 非空      | 原样        |
// | 嵌套                                  | 空        | '未分组'    |
// | 混用（历史脏数据）                    | 按嵌套处理（空→'未分组'；非空原样），发布闸在 categories 上拦，等人工修 |
// 只读判定，不落库；落库补位由调用方以归一后的对执行。
export async function resolveCategoryShape(
  db: D1Database,
  taxonomy: string,
  term: string,
): Promise<{ taxonomy: string; term: string }> {
  const tax = taxonomy.trim();
  const t = term.trim();
  const shape = shapeOfTaxonomy(await categoryShapePairs(db), tax);
  if (shape === 'unknown') return { taxonomy: tax, term: t }; // 新分类可自带子结构
  if (shape === 'nested' || shape === 'mixed') return { taxonomy: tax, term: t === '' ? UNGROUPED_TERM : t };
  return { taxonomy: tax, term: '' }; // flat：垃圾子分类静默丢弃，保住分类本身
}

// 孤儿清理：categories 中无 (taxonomy, term) 精确匹配 sites 行的行删除。
// 调用点仅限「sites 行消失/换形之后」：admin DELETE、extension DELETE、reanalyze 两终点；
// 绝不在 reanalyze 中途（删原行后、重插前）调用——那时原行不在，正常分类行会被误删。
export async function pruneOrphanCategories(db: D1Database): Promise<void> {
  await db
    .prepare(
      `DELETE FROM categories WHERE NOT EXISTS (SELECT 1 FROM sites WHERE sites.taxonomy = categories.taxonomy AND sites.term = categories.term)`,
    )
    .run();
}
