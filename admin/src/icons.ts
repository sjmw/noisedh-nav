// icon 决策链（spec-27 §5）：AI 优先 → 关键词规则表 → 默认。纯规则可离线测。
import type { Env } from './types';
import { UA } from './extract';

export const DEFAULT_ICON = 'fas fa-folder-open fa-lg';
// 接受 fa / fas / far / fab 前缀 + 可选 canonical 尺寸后缀（' fa-lg' 形态，与 DEFAULT_ICON/AI 提示语一致）；其余一律弃（防注入非类名串进前台模板）
export const FA_CLASS = /^fa[sbr]? fa-[a-z][a-z0-9]*(-[a-z0-9]+)*?( fa-(xs|sm|lg|xl|2x|3x|4x|5x))?$/;

// 规则表（spec §5，30 条）：比对序=表序，先命中先赢；键对 toLowerCase 后的名字做 contains（纯 ASCII 小写键另加词边界，见 keyHit）。
const RULES: ReadonlyArray<readonly [string[], string]> = [
  [['设计', '美工', '素材', 'design'], 'fas fa-palette'],
  [['视频', '影视', '剧集', '剪辑', 'video'], 'fas fa-film'],
  [['音乐', '歌曲', 'audio', 'music'], 'fas fa-music'],
  [['游戏', 'game'], 'fas fa-gamepad'],
  [['阅读', '书', '小说', 'book', 'read'], 'fas fa-book-open'],
  [['新闻', '资讯', '热榜', 'news'], 'fas fa-newspaper'],
  [['工具', '效率', 'tool'], 'fas fa-wrench'],
  [['ai', '智能', '机器'], 'fas fa-robot'],
  [['图片', '摄影', '图库', 'photo', 'image'], 'fas fa-image'],
  [['云盘', '资源', '软件', 'drive', 'cloud'], 'fas fa-cloud'],
  [['导航', '聚合', '综合', 'nav'], 'fas fa-compass'],
  [['购物', '电商', 'shop', 'store'], 'fas fa-shopping-cart'],
  [['开发', '代码', '编程', 'dev', 'code'], 'fas fa-code'],
  [['邮箱', '邮件', 'mail'], 'fas fa-envelope'],
  [['动漫', '二次元', '动画'], 'fas fa-masks-theater'],
  [['直播'], 'fas fa-video'],
  [['字幕', '配音'], 'fas fa-closed-captioning'],
  [['封面', '图文'], 'fas fa-image-portrait'],
  [['无人机', '航拍'], 'fas fa-helicopter'],
  [['模版', '模板', '插件'], 'fas fa-puzzle-piece'],
  [['虚拟', '主播'], 'fas fa-vr-cardboard'],
  [['学习', '教育', '词典', '课程'], 'fas fa-graduation-cap'],
  [['搜索', 'search'], 'fas fa-magnifying-glass'],
  [['社交', '社区', '论坛'], 'fas fa-comments'],
  [['地图', '出行', '旅游'], 'fas fa-map'],
  [['财经', '支付', '美元', '股票'], 'fas fa-coins'],
  [['播客', '电台', 'radio'], 'fas fa-podcast'],
  [['博客', '日志', 'blog'], 'fas fa-feather'],
  [['备用', '镜像'], 'fas fa-clone'],
  [['热门', '热'], 'fas fa-fire'],
];

// 规则命中判定：纯 ASCII 小写键要求 ASCII 词边界（前后邻字若非空须非 [a-z0-9]），
// 否则 'mail' 会被 'ai' 子串劫持；含 CJK 的键维持 contains 即中（'AI合成' 照常命中）。
const ASCII_KEY = /^[a-z0-9]+$/;
function keyHit(n: string, k: string): boolean {
  if (!ASCII_KEY.test(k)) return n.includes(k);
  for (let i = n.indexOf(k); i >= 0; i = n.indexOf(k, i + 1)) {
    const before = i === 0 ? '' : n[i - 1]!;
    const after = i + k.length >= n.length ? '' : n[i + k.length]!;
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
  }
  return false;
}

export function iconFor(name: string): string {
  const n = name.toLowerCase();
  for (const [keys, icon] of RULES) if (keys.some((k) => keyHit(n, k))) return icon;
  return DEFAULT_ICON;
}

const AI_ICON_PROMPT =
  '仅输出 JSON {"icon":"..."}。为给定分类名从 Font Awesome 6 Free 选最贴切的一个类名（形如 fas fa-gamepad，可带尺寸后缀）；不确定就返回 fas fa-folder-open fa-lg。';

export async function resolveIcon(name: string, env: Env, fetchImpl: typeof fetch = fetch): Promise<string> {
  const { AI_BASE_URL, AI_API_KEY, AI_MODEL } = env;
  if (!AI_BASE_URL || !AI_API_KEY || !AI_MODEL) return iconFor(name); // 未配置零网络（本地 dev 常态）
  try {
    const res = await fetchImpl(`${AI_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      // UA 纪律源自 extract.ts：workerd 默认 UA 会被 Cloudflare 前置的端点 403（见 extract.ts UA 常量注释）
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Authorization: `Bearer ${AI_API_KEY}` },
      body: JSON.stringify({ model: AI_MODEL, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: AI_ICON_PROMPT }, { role: 'user', content: name }] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return iconFor(name);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '') as { icon?: unknown };
    return typeof parsed.icon === 'string' && FA_CLASS.test(parsed.icon.trim()) ? parsed.icon.trim() : iconFor(name);
  } catch {
    return iconFor(name); // 单题小调用不值得重试：失败即落规则
  }
}
