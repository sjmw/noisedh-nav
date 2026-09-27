// logo 解析链（2026-09-27 用户批准的优化）：显式 logo 最高优先且零网络探测；
// 分析路径下 favicon.im 探测（占位"f"SVG/非 image 类型均视为未命中）→ 网页 HTML 提取
// （apple-touch-icon > icon/shortcut icon > og:image，相对地址按页面 URL 绝对化）→ FAVICON_TEMPLATE 兜底。
// 直通路径保持零网络不变（扩展批量保存不被探测拖慢），只走 显式值 → 模板。
import { describe, it, expect } from 'vitest';
import { extractLogo, probeFaviconIm } from '../src/logo';
import { analyzeAndUpsert } from '../src/pipeline';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFileSync } from 'node:fs';

describe('extractLogo（HTML 图标提取）', () => {
  it('apple-touch-icon 优先于 icon；相对 href 按页面 URL 绝对化', () => {
    const html = `<head>
      <link rel="icon" href="/fav.ico">
      <link rel="apple-touch-icon" href="img/touch.png">
    </head>`;
    expect(extractLogo(html, 'https://site.test/a/b.html')).toBe('https://site.test/a/img/touch.png');
  });
  it('无 apple-touch 用 icon；shortcut icon 同权', () => {
    expect(extractLogo('<link rel="shortcut icon" href="https://cdn.test/i.png">', 'https://site.test/'))
      .toBe('https://cdn.test/i.png');
  });
  it('都没有 → og:image 兜底', () => {
    const html = '<meta property="og:image" content="/share.jpg">';
    expect(extractLogo(html, 'https://site.test/x/y')).toBe('https://site.test/share.jpg');
  });
  it('什么都没有 / 非法 href / 非 http(s) 协议 → 空串', () => {
    expect(extractLogo('<title>x</title>', 'https://site.test/')).toBe('');
    expect(extractLogo('<link rel="icon" href="data:image/png;base64,AAA">', 'https://site.test/')).toBe('');
    expect(extractLogo('<link rel="icon" href="javascript:alert(1)">', 'https://site.test/')).toBe('');
  });
});

const dbMf = new Miniflare({ log: new Log(LogLevel.ERROR), modules: true, script: 'export default{}', d1Databases: ['DB'], d1Persist: false });
let db: any;
const dbInit = async () => {
  const d = await dbMf.getD1Database('DB');
  await d.exec(readFileSync('schema.sql', 'utf8').replace(/--.*$/gm, '').replace(/\s+/g, ' '));
  return d;
};

const FAV_IM = 'favicon.im';
const PLACEHOLDER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#808080" /><text x="50" y="65" font-family="Times New Roman, serif" font-size="50" fill="white" text-anchor="middle" font-style="italic">f</text></svg>';

// 路由式 fake fetch：favicon.im → 按脚本返回 image/占位/500；ai.test 不发（无 AI 配置）；其余 = 页面
const logoFetch = ({ favicon, pageHtml, calls }: { favicon: { status?: number; body: string; type: string } | 'throw'; pageHtml: string; calls: string[] }) =>
  (async (u: any) => {
    calls.push(String(u));
    if (String(u).includes(FAV_IM)) {
      if (favicon === 'throw') throw new Error('network');
      return new Response(favicon.body, { status: favicon.status ?? 200, headers: { 'content-type': favicon.type } });
    }
    return new Response(pageHtml, { headers: { 'content-type': 'text/html' } });
  }) as unknown as typeof fetch;

describe('analyzeAndUpsert logo 解析链', () => {
  it('探测请求必须带浏览器 UA：workerd 默认 UA 实测被 favicon.im 前置 Cloudflare 直接 403', async () => {
    const inits: any[] = [];
    const spyFetch = (async (u: any, init?: any) => {
      inits.push(init);
      return new Response('fake-png', { status: 200, headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    expect(await probeFaviconIm('ua.test', spyFetch)).toBe('https://favicon.im/ua.test?larger=true');
    expect(inits).toHaveLength(1); // 单次尝试、不重试
    const ua = String((inits[0]!.headers as Record<string, string>)['User-Agent']);
    expect(ua).toMatch(/^Mozilla\/5\.0 .*Chrome\//);
  });

  it('favicon.im 命中（image 类型非占位）→ 落 canonical 模板地址，不再用 FAVICON_TEMPLATE', async () => {
    db = await dbInit();
    const calls: string[] = [];
    const env: any = { DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: 'ddg/{host}.ico' };
    const r = await analyzeAndUpsert(
      { url: 'https://favhit.test/x', source: 'manual' }, env, db,
      { fetchImpl: logoFetch({ favicon: { body: '<svg>real</svg>', type: 'image/svg+xml' }, pageHtml: '<title>命中</title>', calls }) },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row.logo).toBe('https://favicon.im/favhit.test?larger=true');
    expect(calls.some((c) => c.includes(FAV_IM + '/favhit.test'))).toBe(true);
  });
  it('favicon.im 返回占位"f"SVG → 回退 HTML 提取（icon 绝对化）', async () => {
    if (!db) db = await dbInit();
    const calls: string[] = [];
    const env: any = { DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: 'ddg/{host}.ico' };
    const r = await analyzeAndUpsert(
      { url: 'https://ph.test/x', source: 'manual' }, env, db,
      { fetchImpl: logoFetch({ favicon: { body: PLACEHOLDER_SVG, type: 'image/svg+xml' }, pageHtml: '<title>占位</title><link rel="icon" href="/site.ico">', calls }) },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row.logo).toBe('https://ph.test/site.ico');
  });
  it('favicon.im 非 image 类型（HTML 错误页）也算未命中', async () => {
    if (!db) db = await dbInit();
    const calls: string[] = [];
    const r = await analyzeAndUpsert(
      { url: 'https://htmlresp.test', source: 'manual' }, { DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: 'ddg/{host}.ico' } as any, db,
      { fetchImpl: logoFetch({ favicon: { body: '<html>nope</html>', type: 'text/html' }, pageHtml: '<title>x</title>', calls }) },
    );
    if (r.ok) expect(r.row.logo).toBe('ddg/htmlresp.test.ico');
  });
  it('favicon.im 网络异常 + 页面无图标 → FAVICON_TEMPLATE 兜底（现状行为）', async () => {
    if (!db) db = await dbInit();
    const calls: string[] = [];
    const r = await analyzeAndUpsert(
      { url: 'https://allfail.test', source: 'manual' }, { DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: 'ddg/{host}.ico' } as any, db,
      { fetchImpl: logoFetch({ favicon: 'throw', pageHtml: '<title>x</title>', calls }) },
    );
    if (r.ok) expect(r.row.logo).toBe('ddg/allfail.test.ico');
  });
  it('显式 logo → 一次 favicon.im 探测都不发', async () => {
    if (!db) db = await dbInit();
    const calls: string[] = [];
    const r = await analyzeAndUpsert(
      { url: 'https://explicit.test', logo: 'my.png', source: 'manual' }, { DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: 'ddg/{host}.ico' } as any, db,
      { fetchImpl: logoFetch({ favicon: { body: '<svg>real</svg>', type: 'image/svg+xml' }, pageHtml: '<title>x</title>', calls }) },
    );
    if (r.ok) expect(r.row.logo).toBe('my.png');
    expect(calls.some((c) => c.includes(FAV_IM))).toBe(false);
  });
  it('直通路径保持零网络：不探测，只 显式值→模板', async () => {
    if (!db) db = await dbInit();
    const calls: string[] = [];
    const r = await analyzeAndUpsert(
      { url: 'https://pass.test', title: '题', taxonomy: 'PT', source: 'extension' }, { DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: 'ddg/{host}.ico' } as any, db,
      { fetchImpl: logoFetch({ favicon: { body: '<svg>real</svg>', type: 'image/svg+xml' }, pageHtml: '<title>x</title>', calls }) },
    );
    if (r.ok) expect(r.row.logo).toBe('ddg/pass.test.ico');
    expect(calls).toEqual([]); // 直通连页面都不抓，更不发探测
  });
});
