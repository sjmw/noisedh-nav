import { describe, it, expect, vi } from 'vitest';
import { extractBaseline, fetchPage } from '../src/extract';

// ---- extractBaseline（brief Step 1 原样） ----
const html = `<html><head><title>CG99-CG设计网 - CG99</title>
<meta name="description" content="专注全球CG设计行业"><meta property="og:site_name" content="CG99"></head><body/></html>`;
describe('extractBaseline', () => {
  it('裁站点后缀取主标题', () => expect(extractBaseline(html).title).toBe('CG99-CG设计网'));
  it('取 meta description', () => expect(extractBaseline(html).description).toBe('专注全球CG设计行业'));
  it('无 meta 用 og:description，再无则空', () => {
    expect(extractBaseline('<title>x</title><meta property="og:description" content="og文">').description).toBe('og文');
    expect(extractBaseline('<title>x</title>').description).toBe('');
  });
  it('title 缺失退到 og:site_name 再退空串', () => {
    expect(extractBaseline('<meta property="og:site_name" content="Site">').title).toBe('Site');
  });

  // ---- 以下为 brief 之外的补充用例 ----
  it('meta 属性支持单引号与属性序颠倒', () => {
    expect(extractBaseline("<meta content='单引号倒序' name='description'>").description).toBe('单引号倒序');
    expect(extractBaseline('<title>主标题</title>').title).toBe('主标题');
  });
  it('title 跨行、HTML 实体与多余空白归一', () => {
    expect(extractBaseline('<title>\n  A &amp; B\n  - 后缀\n</title>').title).toBe('A & B');
  });
  it('管道符分隔无需空格也可裁剪', () => {
    expect(extractBaseline('<title>某站名称|Slogan</title>').title).toBe('某站名称');
    expect(extractBaseline('<title>短|后缀</title>').title).toBe('短|后缀'); // 首段 <4 字符退回整串
  });
  it('空 html 返回全空', () => expect(extractBaseline('')).toEqual({ title: '', description: '' }));
});

// ---- fetchPage（注入假 fetch：截断、错误映射、单次重试） ----
const okResponse = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });

describe('fetchPage', () => {
  it('成功返回 html，并透传超时 signal / 浏览器 UA / 跟随重定向', async () => {
    const fake = vi.fn(async (_u: string | URL, _init?: RequestInit) => okResponse('<title>ok</title>'));
    const r = await fetchPage('https://a.cn', fake as unknown as typeof fetch);
    expect(r).toEqual({ html: '<title>ok</title>' });
    const init = fake.mock.calls[0]![1]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('follow');
    expect(new Headers(init.headers).get('user-agent')).toMatch(/^Mozilla\//);
  });
  it('body 截断到 64KB（utf-8 解码）', async () => {
    const fake = vi.fn(async () => okResponse('x'.repeat(100_000)));
    const r = await fetchPage('https://a.cn', fake as unknown as typeof fetch);
    expect('html' in r && new TextEncoder().encode(r.html).length).toBeLessThanOrEqual(65536);
    expect('html' in r && r.html.length).toBeGreaterThan(0);
  });
  it('网络异常重试一次后返回 fetch_failed，且永不 reject', async () => {
    const fake = vi.fn(async () => { throw new Error('network down'); });
    const r = await fetchPage('https://a.cn', fake as unknown as typeof fetch);
    expect(r).toEqual({ error: 'fetch_failed' });
    expect(fake).toHaveBeenCalledTimes(2);
  });
  it('非 ok 状态同样映射 fetch_failed 并重试一次', async () => {
    const fake = vi.fn(async () => new Response('nope', { status: 500 }));
    const r = await fetchPage('https://a.cn', fake as unknown as typeof fetch);
    expect(r).toEqual({ error: 'fetch_failed' });
    expect(fake).toHaveBeenCalledTimes(2);
  });
  it('首次失败、重试成功则返回 html', async () => {
    let calls = 0;
    const fake = vi.fn(async () => { if (++calls === 1) throw new Error('transient'); return okResponse('<b>ok</b>'); });
    const r = await fetchPage('https://a.cn', fake as unknown as typeof fetch);
    expect(r).toEqual({ html: '<b>ok</b>' });
    expect(fake).toHaveBeenCalledTimes(2);
  });
});
