// Task 8：GitHub Contents 读写 + 发布流程。
// 核心是修正扩展的 latin1 编解码坑：解码必须 Uint8Array.from(atob) + TextDecoder('utf-8')，
// 编码必须 TextEncoder 字节 → 分块二进制串 → btoa（避免 String.fromCharCode(...arr) 在 ~50KB+ yml 上溢出）。
// 409 语义（spec §5.4）：重 GET 后远端=本次将写内容 → 幂等成功；否则 github_conflict 中止，绝不二次 PUT。
// 发布即快照：pending 行以「临时 published」参与构建，仅 GitHub 写成功后才回写 D1 状态。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readFileSync } from 'node:fs';
import { ghGet, ghPut, GithubApiError } from '../src/github';
import { doPublish } from '../src/publish';
import { insertSite, deleteSite, allPublishedRows, getSiteByUrl } from '../src/db';
import type { Env } from '../src/types';

// GitHub 返回的 base64 带换行（每 ~76 字符），fixture 必须复刻该形态
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8');
const wrap = (s: string) => s.replace(/(.{76})/g, '$1\n');

interface Rec { url: string; method: string; headers: Record<string, string>; body: string }
type Reply = { status?: number; body: unknown } | ((call: Rec, index: number) => { status?: number; body: unknown });

// 脚本化假 fetch：按调用次序消费 replies，记录完整请求面（url/method/headers/body）供断言
const mkFetch = (replies: Reply[]) => {
  const calls: Rec[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const rec: Rec = {
      url: String(url),
      method: String((init as { method?: string })?.method ?? 'GET'),
      headers: Object.fromEntries(new Headers((init as { headers?: HeadersInit })?.headers).entries()),
      body: String((init as { body?: string })?.body ?? ''),
    };
    calls.push(rec);
    const r = replies[calls.length - 1];
    if (!r) throw new Error(`fake fetch: 脚本化响应已耗尽（第 ${calls.length} 次调用 ${rec.url}）`);
    const reply = typeof r === 'function' ? r(rec, calls.length - 1) : r;
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

const YML_CN = '---\n- taxonomy: 频道页面\n  icon: fas fa-tv\n  links:\n    - title: 例子频道\n      url: https://example.test\n      description: 中文描述，含「冒号: 」与 emoji 🎈\n';

describe('github.ts：Contents 读写与 UTF-8 编解码', () => {
  it('ghGet：URL/头正确，base64（含换行）→ UTF-8 解码中文无损，sha 透传', async () => {
    const { calls, fetchImpl } = mkFetch([{ body: { name: 'webstack.yml', encoding: 'base64', content: wrap(b64(YML_CN)), sha: 'sha-remote-1' } }]);
    const r = await ghGet('sjmw/noisedh-nav', 'data/webstack.yml', 'ghtok', fetchImpl);
    expect(r.text).toBe(YML_CN); // 若实现走 plain atob（latin1）这里必然乱码
    expect(r.sha).toBe('sha-remote-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.github.com/repos/sjmw/noisedh-nav/contents/data/webstack.yml?ref=main');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers.authorization).toBe('Bearer ghtok');
    expect(calls[0]!.headers.accept).toContain('application/vnd.github+json');
    // 负面守卫：证明本用例确实能捕获 latin1 坑（plain atob 产出与 UTF-8 文本不同）
    expect(atob(wrap(b64(YML_CN)))).not.toBe(YML_CN);
  });

  it('ghPut：body {message,content,branch,sha}，content 为 UTF-8→base64；200 → commitUrl', async () => {
    const { calls, fetchImpl } = mkFetch([{ body: { commit: { html_url: 'https://github.com/sjmw/noisedh-nav/commit/c1', sha: 'c1' } } }]);
    const r = await ghPut('sjmw/noisedh-nav', 'data/webstack.yml', YML_CN, 'sha-remote-1', '后台发布：1 条站点（1 条新增）', 'ghtok', fetchImpl);
    expect(r.commitUrl).toBe('https://github.com/sjmw/noisedh-nav/commit/c1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.github.com/repos/sjmw/noisedh-nav/contents/data/webstack.yml');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.headers.authorization).toBe('Bearer ghtok');
    expect(calls[0]!.headers.accept).toContain('application/vnd.github+json');
    const body = JSON.parse(calls[0]!.body);
    expect(body.branch).toBe('main');
    expect(body.sha).toBe('sha-remote-1'); // sha 透传
    expect(body.message).toBe('后台发布：1 条站点（1 条新增）');
    expect(unb64(body.content)).toBe(YML_CN);
    expect(body.content).toBe(b64(YML_CN)); // 与标准 UTF-8→base64 逐字节一致
  });

  it('ghPut：409（GitHub body {message,documentation_url}）→ GithubApiError(status=409)；401 → status=401', async () => {
    const { fetchImpl } = mkFetch([{ status: 409, body: { message: 'failed to update ref', documentation_url: 'https://docs.github.com/rest' } }]);
    await expect(ghPut('a/b', 'p', 't', 's', 'm', 'tok', fetchImpl)).rejects.toMatchObject({ status: 409 });
    const { fetchImpl: f401 } = mkFetch([{ status: 401, body: { message: 'Bad credentials', documentation_url: 'https://docs.github.com' } }]);
    const err = await ghPut('a/b', 'p', 't', 's', 'm', 'tok', f401).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubApiError);
    expect((err as GithubApiError).status).toBe(401);
  });

  it('大文件往返：≈190KB 中文 yml 编解码逐字节一致（分块防 spread 溢出；sha 过期后 PUT 的 content 可被 ghGet 原样解回）', async () => {
    const big = '- title: 频道页面标题\n  url: https://ch.example.test/页面-' + '哈'.repeat(2) + '\n';
    const text = '---\n' + big.repeat(5000); // ≈ 200KB UTF-8
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(50 * 1024);
    const { calls, fetchImpl } = mkFetch([{ body: { commit: { html_url: 'u', sha: 's' } } }]);
    await ghPut('a/b', 'data/webstack.yml', text, 'sha0', 'm', 'tok', fetchImpl);
    const sent = JSON.parse(calls[0]!.body).content as string;
    expect(sent).toBe(b64(text)); // 与 Buffer 标准实现一致（错误 spread 会在此抛 RangeError 或产出坏字节）
    const { fetchImpl: getBack } = mkFetch([{ body: { content: wrap(sent), sha: 's2' } }]);
    expect((await ghGet('a/b', 'data/webstack.yml', 'tok', getBack)).text).toBe(text); // 编解码对称往返
  });
});

// ── doPublish：真实 D1（miniflare，同 pipeline.test.ts）+ 脚本化假 fetch ──
const mf = new Miniflare({ log: new Log(LogLevel.ERROR), modules: true, script: 'export default{}', d1Databases: ['DB'], d1Persist: false });
let db: any;
beforeAll(async () => {
  db = await mf.getD1Database('DB');
  await db.exec(readFileSync('schema.sql', 'utf8').replace(/--.*$/gm, '').replace(/\s+/g, ' '));
});
afterAll(async () => { await mf.dispose(); });

const mkEnv = (extra: Partial<Env> = {}): Env =>
  ({ ADMIN_TOKEN: 't', GITHUB_TOKEN: 'ghtok', DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: '', REPO: 'sjmw/noisedh-nav', DB: db, ...extra }) as unknown as Env;

const okGet = (sha: string): Reply => ({ body: { content: wrap(b64('---\n')), sha } });
const okPut = (n = 1): Reply[] => Array.from({ length: n }, (_, i) => ({ body: { commit: { html_url: `https://github.com/sjmw/noisedh-nav/commit/c${i}`, sha: `c${i}` } } }));

const seed = async (url: string, status: 'pending' | 'published', title = '频道页面站', taxonomy = '频道页面') =>
  insertSite(db, { url, url_raw: url, title, description: '', logo: '', taxonomy, term: '', status, source: 'manual', sort: 0 });

describe('doPublish（发布即快照 + 冲突中止）', () => {
  it('成功路径：GET→PUT 各恰一次；PUT 内容含 pending 行（快照）；count=写后 published 总数；成功后 pending→published', async () => {
    await seed('https://pub-a.test/', 'published', '已发频道A');
    await seed('https://pend-a.test/', 'pending', '待审频道B');
    const beforePublished = (await allPublishedRows(db)).length;
    const { calls, fetchImpl } = mkFetch([okGet('sha-9'), okPut()[0]!]);
    const r = await doPublish(mkEnv(), db, fetchImpl);
    expect(r).toMatchObject({ ok: true, commitUrl: 'https://github.com/sjmw/noisedh-nav/commit/c0', count: beforePublished + 1 });
    expect(calls).toHaveLength(2); // 恰一次 GET + 一次 PUT
    expect(calls[1]!.method).toBe('PUT');
    expect(calls[1]!.url).toContain('repos/sjmw/noisedh-nav/contents/data/webstack.yml');
    expect(calls[1]!.headers.authorization).toBe('Bearer ghtok');
    const body = JSON.parse(calls[1]!.body);
    expect(body.branch).toBe('main');
    expect(body.sha).toBe('sha-9');
    const written = unb64(body.content);
    expect(written).toContain('已发频道A');
    expect(written).toContain('待审频道B'); // 发布即快照：pending 随本次 publish 进入 yml
    expect(written).toContain('频道页面');
    expect(body.message).toMatch(/^后台发布：\d+ 条站点（\d+ 条新增）$/);
    const row = await getSiteByUrl(db, 'https://pend-a.test/');
    expect(row?.status).toBe('published'); // 成功后状态回写
  });

  it('409 → 重 GET 内容有非本次发布差异 → github_conflict；PUT 全程恰 1 次；pending 不动', async () => {
    await seed('https://pend-b.test/', 'pending', '待审频道C');
    const { calls, fetchImpl } = mkFetch([
      okGet('sha-stale'),
      { status: 409, body: { message: 'failed to update ref', documentation_url: 'https://docs.github.com/rest' } },
      { body: { content: wrap(b64('---\n- taxonomy: 别人改的\n  links:\n    - title: 外来改动\n      url: https://intruder.test\n')), sha: 'sha-new' } },
    ]);
    const r = await doPublish(mkEnv(), db, fetchImpl);
    expect(r).toMatchObject({ ok: false, code: 'github_conflict' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'GET']); // 无第二次 PUT
    expect((await getSiteByUrl(db, 'https://pend-b.test/'))?.status).toBe('pending');
  });

  it('409 → 重 GET 内容 = 本次将写内容 → 幂等成功；pending 照常翻转；仍无第二次 PUT', async () => {
    await seed('https://pend-c.test/', 'pending', '待审频道D');
    const echo: Reply[] = [
      okGet('sha-x'),
      { status: 409, body: { message: 'update-ref failed', documentation_url: 'x' } },
      // 远端已被并发推成与本次完全相同的内容：回显 PUT body 的 content
      (call) => ({ body: { content: wrap(JSON.parse(calls[1]!.body).content), sha: 'sha-z' } }),
    ];
    const { calls, fetchImpl } = mkFetch(echo);
    const r = await doPublish(mkEnv(), db, fetchImpl);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.commitUrl).toContain('github.com/sjmw/noisedh-nav');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'GET']);
    expect((await getSiteByUrl(db, 'https://pend-c.test/'))?.status).toBe('published');
  });

  it('GitHub 写失败（非 409，HTTP 500）→ fetch_failed；pending 完全不动', async () => {
    await seed('https://pend-d.test/', 'pending', '待审频道E');
    const { calls, fetchImpl } = mkFetch([okGet('sha-e'), { status: 500, body: { message: 'backend error' } }]);
    const r = await doPublish(mkEnv(), db, fetchImpl);
    expect(r).toMatchObject({ ok: false, code: 'fetch_failed' });
    expect(calls).toHaveLength(2); // 失败后不再 GET/PUT（不重试）
    expect((await getSiteByUrl(db, 'https://pend-d.test/'))?.status).toBe('pending');
  });

  it('缺 GITHUB_TOKEN → fetch_failed 且零网络调用；REPO 未配置 → 落默认 sjmw/noisedh-nav', async () => {
    const empty = mkFetch([]);
    const r = await doPublish(mkEnv({ GITHUB_TOKEN: '' as string }), db, empty.fetchImpl);
    expect(r).toMatchObject({ ok: false, code: 'fetch_failed' });
    expect(empty.calls).toHaveLength(0);
    const { calls, fetchImpl } = mkFetch([okGet('sha-f'), okPut()[0]!]);
    const r2 = await doPublish(mkEnv({ REPO: undefined as unknown as string }), db, fetchImpl);
    expect(r2.ok).toBe(true);
    expect(calls[1]!.url).toContain('repos/sjmw/noisedh-nav/contents/data/webstack.yml');
  });

  it('mixed taxonomy（同分类空/非空 term 混用）→ bad_request，零网络调用，pending 不动', async () => {
    const p1 = await seed('https://mix-a.test/', 'pending', '混A', '混用类');
    const p2 = await seed('https://mix-b.test/', 'pending', '混B', '混用类');
    await insertSite(db, { url: 'https://mix-c.test/', url_raw: 'https://mix-c.test/', title: '混C', description: '', logo: '', taxonomy: '混用类', term: '子项', status: 'pending', source: 'manual', sort: 0 });
    const { calls, fetchImpl } = mkFetch([]);
    const r = await doPublish(mkEnv(), db, fetchImpl);
    expect(r).toMatchObject({ ok: false, code: 'bad_request' });
    expect(calls).toHaveLength(0);
    for (const id of [p1.id, p2.id]) await deleteSite(db, id); // 清理，避免污染其它用例的全量快照
    await deleteSite(db, (await getSiteByUrl(db, 'https://mix-c.test/'))!.id);
  });
});
