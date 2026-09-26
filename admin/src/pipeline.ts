// 解析流水线（spec §4，导入/新增/重分析共用）：
// normalizeUrl → 查重 → 显式直通或 抓取→基线→(AI)→降级 → logo 兜底 → 补分类 → insertSite(pending)。

import { normalizeUrl } from './url';
import { fetchPage, extractBaseline } from './extract';
import { aiAnalyze } from './ai';
import { getSiteByUrl, insertSite, upsertCategory, allCategories } from './db';
import type { AiResult } from './ai';
import type { CategoryRow, Env, SiteRow } from './types';
import type { ErrCode } from './errors';

export interface AnalyzeOpts {
  url: string;
  title?: string;
  description?: string;
  taxonomy?: string;
  term?: string;
  logo?: string;
  source?: string; // import|manual|extension|seed，缺省 manual
}

export type AnalyzeResult = { ok: true; row: SiteRow; deduped: boolean } | { ok: false; code: ErrCode };

const trim = (s: string | undefined): string => (s ?? '').trim();

// AI 输入正文：剥 script/style（含其内容）与全部标签，压缩空白，取前 4KB（spec §4.1「正文文本截 ~4KB」）
export function buildPageText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4096);
}

export async function analyzeAndUpsert(
  opts: AnalyzeOpts,
  env: Env,
  db: D1Database,
  deps: { fetchImpl?: typeof fetch; now?: () => Date } = {},
): Promise<AnalyzeResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  // Task 2 遗留：normalizeUrl 仅在无协议分支 trim，这里统一先 trim
  const raw = trim(opts.url);
  const url = raw === '' ? null : normalizeUrl(raw);
  if (!url) return { ok: false, code: 'bad_request' };
  if (await getSiteByUrl(db, url)) return { ok: false, code: 'dup_url' }; // 判重语义由上层（扩展兼容层）决定是否转为更新

  const host = new URL(url).hostname;
  const cats = await allCategories(db);
  const baseline: { title: string; description: string } = { title: '', description: '' };
  const eTitle = trim(opts.title);
  const eTax = trim(opts.taxonomy);
  let title = '';
  let description = '';
  let taxonomy = '';
  let term = '';

  if (eTitle !== '' && eTax !== '') {
    // 扩展直通：title+taxonomy 同时显式给出 → 不抓取、不调 AI
    title = eTitle;
    taxonomy = eTax;
    description = trim(opts.description);
    term = trim(opts.term);
  } else {
    const page = await fetchPage(url, fetchImpl);
    const html = 'html' in page ? page.html : '';
    const base = html === '' ? baseline : extractBaseline(html);
    const aiOk: AiResult | null =
      html !== '' && env.AI_BASE_URL && env.AI_API_KEY && env.AI_MODEL
        ? await aiAnalyze(
            { url, pageText: buildPageText(html), baselineTitle: base.title, categories: [...new Set(cats.map((c) => c.taxonomy))] },
            env,
            fetchImpl,
          )
        : null;
    // aiAnalyze 全有或全无返回；这里再执行「trim 后 taxonomy 为空 → 视同不合规」的落库前校验（Task 5 结转裁决 a）
    if (aiOk && trim(aiOk.taxonomy) !== '') {
      title = trim(aiOk.title) || base.title || host;
      // AI 合法但 description 为空串（校验允许）→ 回落基线，不采信空值（Task 6 结转）
      description = trim(aiOk.description) || base.description;
      taxonomy = trim(aiOk.taxonomy);
      term = trim(aiOk.term);
    } else {
      // 降级：基线 + DEFAULT_TAXONOMY；页面不可达时标题退化为 host（spec §4.4）
      title = base.title || host;
      description = base.description;
      taxonomy = trim(env.DEFAULT_TAXONOMY) || '未分类';
      term = '';
    }
    // 非直通时显式字段仍按字段覆盖分析结果（hint 语义）
    if (eTitle !== '') title = eTitle;
    if (trim(opts.description) !== '') description = trim(opts.description);
    if (eTax !== '') taxonomy = eTax;
    if (trim(opts.term) !== '') term = trim(opts.term);
  }

  let logo = trim(opts.logo);
  if (logo === '' && env.FAVICON_TEMPLATE) logo = env.FAVICON_TEMPLATE.replace(/\{host\}/g, host);

  // 最终 (taxonomy, term) 组合缺失时补 categories 行（发布导出依赖 icon）
  if (!cats.some((c: CategoryRow) => c.taxonomy === taxonomy && c.term === term)) {
    await upsertCategory(db, { taxonomy, term });
  }

  let row: SiteRow;
  try {
    row = await insertSite(db, {
      url,
      url_raw: raw,
      title,
      description,
      logo,
      taxonomy,
      term,
      status: 'pending',
      source: trim(opts.source) || 'manual',
      sort: 0, // 默认 0（schema 缺省），排序调整由管理页 PATCH 承担
    });
  } catch (e) {
    // 前置查重通过后的并发竞态：UNIQUE(url) 冲突说明已被他人插入，语义等同 dup（Task 6 结转）
    if (String((e as { message?: unknown })?.message).includes('UNIQUE constraint failed: sites.url')) return { ok: false, code: 'dup_url' };
    throw e;
  }
  return { ok: true, row, deduped: false };
}
