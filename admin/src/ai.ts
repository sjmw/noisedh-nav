// AI 分析：OpenAI 兼容 chat/completions 调用（超时 + 单次重试，与 extract.ts 同一纪律），
// 输出全有或全无校验——任何不合规一律 null（不截断、不半采信），调用方走基线降级。

import type { Env } from './types';
import { FA_CLASS } from './icons';

export interface AiResult {
  title: string;
  description: string;
  taxonomy: string;
  term: string;
  newCategory: boolean;
  // spec-27 §5：可选 icon（''=AI 未给/不合法——仅弃本字段，整条结果不降级）
  icon: string;
}

export interface AiInput {
  url: string;
  pageText: string;
  baselineTitle: string;
  categories: string[];
  // 冒烟修复轮（AI 改造）：taxonomy→非空 term 清单（来源=categories∪sites union，由 pipeline 传入）。
  // validate 仍只按 categories 精确匹配（不动）；本字段仅进 systemPrompt 供 AI 选term。
  subcategories: Record<string, string[]>;
}

const TIMEOUT_MS = 20000; // AI 生成比抓页慢，单独放宽
const MAX_ATTEMPTS = 2; // 首次 + 单次重试
const MAX_PAGE_TEXT = 3000; // user 消息截断，控制 token
const TITLE_MAX = 30; // 「≤30字」：超限整条降级 null（不半采信），按码点计数
const DESC_MAX = 40;

const systemPrompt = (categories: string[], subcategories: Record<string, string[]>): string => {
  // 只列有子分类的 taxonomy：flat/无清单的分类不进表（prompt 中「不在表里→term 空串」即平铺语义）
  const subLines = Object.entries(subcategories)
    .filter(([, terms]) => terms.length > 0)
    .map(([tax, terms]) => `${tax}：${terms.join('、')}`)
    .join('\n');
  return (
    `你是网站收录分析助手。仅输出 JSON，不要输出任何其他文字。字段：` +
    `title(≤30字,去站点后缀)、description(≤40字,中文,概括网站做什么)、taxonomy、term(可为空串)、new_category(布尔)。` +
    `taxonomy 必须给出且非空：优先从给定分类列表中选择：${categories.join('、')}；` +
    `列表没有合适的→提议一个简短新分类名并置 new_category=true。` +
    (subLines !== '' ? `以下分类带子分类结构（分类：子分类清单）：\n${subLines}\n` : '') +
    `所选分类在上述清单中时，term 必须给出：优先从该分类子分类中选一个，都不合适就提一个简短新子分类名；` +
    `不在清单中（平铺/无子分类）的分类 term 给空串。` +
    `可附 icon(Font Awesome 6 free 类名，如 fas fa-gamepad；new_category=true 时尽量给出)。`
  );
};

const userPrompt = (input: AiInput): string =>
  `URL：${input.url}\n原标题：${input.baselineTitle}\n页面正文摘要：${input.pageText.slice(0, MAX_PAGE_TEXT)}`;

// 严格校验：非对象 / 缺任一字段 / 类型错 / 超长 / taxonomy 不在列表且 new_category!==true → null。
// 注意 term 区分「缺失」与「空串」：空串合法（typeof 检查即可），缺键 → undefined → null。
function validate(raw: unknown, categories: string[]): AiResult | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const { title, description, taxonomy, term, new_category: newCategory } = o;
  if (typeof title !== 'string' || typeof description !== 'string' ||
      typeof taxonomy !== 'string' || typeof term !== 'string' || typeof newCategory !== 'boolean') return null;
  if ([...title].length > TITLE_MAX || [...description].length > DESC_MAX) return null;
  if (!categories.includes(taxonomy) && newCategory !== true) return null;
  // icon 是可选附加字段：非法/缺失只置空串，不影响整条校验结论
  const icon = typeof o.icon === 'string' && FA_CLASS.test(o.icon.trim()) ? o.icon.trim() : '';
  return { title, description, taxonomy, term, newCategory, icon };
}

export async function aiAnalyze(
  input: AiInput,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<AiResult | null> {
  const { AI_BASE_URL, AI_API_KEY, AI_MODEL } = env;
  if (!AI_BASE_URL || !AI_API_KEY || !AI_MODEL) return null; // 未配置：直接降级，不发请求
  const base = AI_BASE_URL.replace(/\/+$/, '');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
        body: JSON.stringify({
          model: AI_MODEL,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt(input.categories, input.subcategories) },
            { role: 'user', content: userPrompt(input) },
          ],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) continue; // 非 ok 视同失败，走重试/兜底
      const data: unknown = await res.json();
      const content: unknown = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') return null; // 响应结构不合规：内容确定，重试无益，整条降级
      let parsed: unknown;
      try {
        parsed = JSON.parse(content); // AI 可能包裹 ```json 围栏？json_object 模式下按裸 JSON 处理
      } catch {
        return null;
      }
      return validate(parsed, input.categories);
    } catch {
      // 超时/网络异常：重试一次，仍失败落到 null
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
