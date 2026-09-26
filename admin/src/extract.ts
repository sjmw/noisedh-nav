// 页面抓取与基线提取：纯字符串解析（无 npm 依赖），外部 fetch 一律带超时 + 单次重试。

export interface Baseline { title: string; description: string }

const decodeEntities = (s: string): string =>
  s.replace(/&#(\d+);|&#x([0-9a-f]+);|&amp;|&lt;|&gt;|&quot;|&#0?39;|&apos;/gi, (m, dec, hex) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&#039;': "'" }[m.toLowerCase()] ?? m;
  });

const clean = (s: string): string => decodeEntities(s.replace(/\s+/g, ' ')).trim();

// 全部 meta 标签逐个解析属性（大小写不敏感、支持单/双/无引号与属性序颠倒）
function metaContent(html: string, key: 'description' | 'og:description' | 'og:site_name'): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/(name|property|content)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi))
      attrs[(m[1] as string).toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    const k = (attrs.name ?? attrs.property ?? '').toLowerCase();
    if (k === key && attrs.content !== undefined) return clean(attrs.content);
  }
  return undefined;
}

// 后缀裁剪：破折号类分隔符须两侧带空格（保住 'CG99-CG设计网' 这类连字符标题），
// 管道类可无空格；首段长度 ≥4 才取首段，否则整串。
function stripSuffix(title: string): string {
  const parts = title.split(/\s+[-–—]\s+|\s*[|｜]\s*/);
  return parts.length > 1 && parts[0]!.length >= 4 ? parts[0]! : title;
}

export function extractBaseline(html: string): Baseline {
  const rawTitle = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = rawTitle !== undefined && rawTitle.trim() !== ''
    ? stripSuffix(clean(rawTitle))
    : (metaContent(html, 'og:site_name') ?? '');
  return {
    title,
    description: metaContent(html, 'description') ?? metaContent(html, 'og:description') ?? '',
  };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_BYTES = 65536; // 64KB
const TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 2; // 首次 + 单次重试

export async function fetchPage(url: string, fetchImpl: typeof fetch = fetch): Promise<{ html: string } | { error: 'fetch_failed' }> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal: ctrl.signal });
      if (!res.ok) continue; // 非 ok 视同失败，走重试/兜底
      const buf = await res.arrayBuffer();
      const html = new TextDecoder('utf-8').decode(buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf);
      return { html };
    } catch {
      // 超时/网络异常：重试一次，仍失败落到 fetch_failed
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: 'fetch_failed' };
}
