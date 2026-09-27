// logo 解析链的两块零件（2026-09-27 优化：favicon.im 优先，网页提取回退）：
// - probeFaviconIm：真实网络探测（超时 + 浏览器 UA，单次尝试不重试——回落链已兜底，重试徒增延迟）。
//   favicon.im 对任何域名都 200：查无图标时返回固定的灰色"f"占位 SVG，
//   所以「命中」= 200 且 content-type 为 image/* 且非占位图；命中时返回
//   canonical 地址（不存 302 后的 a.favicon.im，稳定），未命中返回 ''。
// - extractLogo：纯字符串解析（零依赖），apple-touch-icon > icon/shortcut icon > og:image，
//   相对地址按页面 URL 绝对化，仅接受 http(s)。

import { UA } from './extract';

const PROBE_TIMEOUT_MS = 6000;
// 单次尝试、不重试：探测失败=走下一级回落链（HTML 提取→模板），重试只会翻倍整条流水线延迟
const PROBE_ATTEMPTS = 1;
export const FAVICON_IM = (host: string): string => `https://favicon.im/${host}?larger=true`;

// 必须带浏览器 UA：favicon.im 挂在 Cloudflare 后面，workerd 默认 UA 实测被直接 403（text/html 挑战页）。
// UA 常量与页面抓取同源（src/extract.ts）。
const PROBE_HEADERS = { 'User-Agent': UA, Accept: 'image/*,*/*' };

// 占位图特征：灰色圆底 + 衬线斜体 f 的 100x100 SVG（favicon.im 兜底图，实测 257B）。
// 按内容特征而非字节长度判定——CDN 压缩/边缘节点差异会让长度不稳。
const isPlaceholder = (body: string): boolean =>
  body.includes('viewBox="0 0 100 100"') && body.includes('fill="#808080"') && body.includes('>f</text>');

export async function probeFaviconIm(host: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = FAVICON_IM(host);
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { redirect: 'follow', headers: PROBE_HEADERS, signal: ctrl.signal });
      if (!res.ok) continue; // 非 ok（含无 UA 时被 CF 前置的 403）视同失败，按未命中走回落链
      const type = res.headers.get('content-type') ?? '';
      if (!type.startsWith('image/')) continue; // HTML 错误页/JSON 报错都不算命中
      const body = await res.text(); // 真图标（png/ico 二进制）读成乱码串无妨，只为占位判定
      if (type.includes('svg') && isPlaceholder(body)) return ''; // 灰"f"占位 = 查无此站图标
      return url; // 命中：落 canonical 地址
    } catch {
      // 超时/网络异常：单次尝试不重试，直接落未命中
    } finally {
      clearTimeout(timer);
    }
  }
  return '';
}

// link 标签属性解析（rel + href，大小写不敏感、支持单/双/无引号）
function linkRelHref(html: string, rels: string[]): string | undefined {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/(rel|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi))
      attrs[(m[1] as string).toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    const rel = (attrs.rel ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    // rel 可能是组合值（"shortcut icon"），按 token 匹配
    if (rels.some((r) => rel.split(' ').includes(r)) && attrs.href) return attrs.href;
  }
  return undefined;
}

function metaContent(html: string, key: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/(property|name|content)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi))
      attrs[(m[1] as string).toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    const k = (attrs.property ?? attrs.name ?? '').toLowerCase();
    if (k === key && attrs.content) return attrs.content;
  }
  return undefined;
}

const absHttp = (href: string | undefined, pageUrl: string): string => {
  if (!href) return '';
  try {
    const u = new URL(href.trim(), pageUrl);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return ''; // data:/javascript:/垃圾串一律拒
  }
};

export function extractLogo(html: string, pageUrl: string): string {
  return (
    absHttp(linkRelHref(html, ['apple-touch-icon']), pageUrl) ||
    absHttp(linkRelHref(html, ['icon', 'shortcut']), pageUrl) ||
    absHttp(metaContent(html, 'og:image'), pageUrl)
  );
}
