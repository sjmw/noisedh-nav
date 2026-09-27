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
import {
  insertSite, deleteSite, allPublishedRows, allPendingRows, allCategories, getSiteByUrl,
  insertFriendlink, insertNavitem, allFriendlinks, allNavitems,
} from '../src/db';
import { buildWebstackYml, buildFriendlinksYml, buildNavYml } from '../src/yml';
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
    expect(calls[0]!.headers['user-agent']).toBeTruthy(); // GitHub UA 强制政策：无 UA 一律 403（2026-09-27 部署实测）
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
    expect(calls[0]!.headers['user-agent']).toBeTruthy(); // 同上：PUT 也必须带 UA
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

  it('ghPut：sha=null → PUT body 不含 sha 字段（Contents API 新建文件路径；Task 9 预检 404 后新建用）', async () => {
    const { calls, fetchImpl } = mkFetch([{ body: { commit: { html_url: 'u', sha: 's' } } }]);
    await ghPut('a/b', 'data/friendlinks.yml', '[]\n', null, 'm', 'tok', fetchImpl);
    const body = JSON.parse(calls[0]!.body);
    expect('sha' in body).toBe(false); // 键必须整个缺席，而非空串
    expect(body.branch).toBe('main');
    expect(unb64(body.content)).toBe('[]\n');
  });

  it('ghGet 单次重试（spec §8）：瞬时失败（fetch 抛出/5xx）重试恰 1 次；4xx 确定性失败不重试', async () => {
    // 第 1 次抛（等价超时/断网），第 2 次成功 → 共 2 次调用且结果正确
    const { calls, fetchImpl } = mkFetch([
      () => { throw new Error('模拟 TimeoutError（AbortSignal.timeout）'); },
      { body: { content: wrap(b64(YML_CN)), sha: 'sha-retry' } },
    ]);
    const r = await ghGet('a/b', 'data/webstack.yml', 'tok', fetchImpl);
    expect(r.text).toBe(YML_CN);
    expect(r.sha).toBe('sha-retry');
    expect(calls).toHaveLength(2);
    // 5xx 亦瞬时：重试 1 次后仍失败即抛出，绝不第 3 次
    const f2 = mkFetch([{ status: 502, body: { message: 'bad gateway' } }, { status: 502, body: { message: 'bad gateway' } }]);
    await expect(ghGet('a/b', 'p', 'tok', f2.fetchImpl)).rejects.toMatchObject({ status: 502 });
    expect(f2.calls).toHaveLength(2);
    // 401 为确定性失败：不重试，仅 1 次
    const f3 = mkFetch([{ status: 401, body: { message: 'Bad credentials' } }]);
    await expect(ghGet('a/b', 'p', 'tok', f3.fetchImpl)).rejects.toBeInstanceOf(GithubApiError);
    expect(f3.calls).toHaveLength(1);
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

// ── doPublish：真实 D1（miniflare，同 pipeline.test.ts）+ GitHub 假实现 ──
const mf = new Miniflare({ log: new Log(LogLevel.ERROR), modules: true, script: 'export default{}', d1Databases: ['DB'], d1Persist: false });
let db: any;
beforeAll(async () => {
  db = await mf.getD1Database('DB');
  await db.exec(readFileSync('schema.sql', 'utf8').replace(/--.*$/gm, '').replace(/\s+/g, ' '));
});
afterAll(async () => { await mf.dispose(); });

// ── doPublish：真实 D1（miniflare，同 pipeline.test.ts）+ 按 path 路由的假 GitHub ──
// Task 9 三文件化后预检是三路并行 GET，调用次序受微任务调度影响不再恒定——
// 假实现放弃「按次序消费脚本」，改为维护 path → {sha,text} 的远端虚拟仓库，GET/PUT 按 path 分发。
const WS = 'data/webstack.yml';
const FLP = 'data/friendlinks.yml';
const NVP = 'data/headers.yml';

interface PutScript { status?: number; conflictTo?: 'sent' | string } // conflictTo：409 时把远端改成…（'sent'=本次将写内容，模拟并发推入相同字节）
interface GHOpts {
  initial?: Partial<Record<string, string | null>>; // 缺省/null = 远端不存在该 path（GET 404）
  putScripts?: Partial<Record<string, PutScript[]>>; // 按 path 的 PUT 覆盖脚本（ FIFO），无脚本则默认成功
  getThrows?: Partial<Record<string, number>>; // 该 path 前 N 次 GET 直接抛（模拟超时/断网，喂 ghGet 单次重试）
}
const mkGH = (opts: GHOpts = {}) => {
  const calls: Rec[] = [];
  const remote = new Map<string, { sha: string; text: string }>();
  for (const [p, t] of Object.entries(opts.initial ?? {})) {
    if (typeof t === 'string') remote.set(p, { sha: `sha-${p}-init`, text: t });
  }
  const scripts = new Map<string, PutScript[]>();
  for (const [p, list] of Object.entries(opts.putScripts ?? {})) if (list) scripts.set(p, list);
  const throws: Record<string, number> = {};
  for (const [p, n] of Object.entries(opts.getThrows ?? {})) if (n) throws[p] = n;
  let putSeq = 0;
  const jsonRes = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const rec: Rec = {
      url: String(url),
      method: String((init as { method?: string })?.method ?? 'GET'),
      headers: Object.fromEntries(new Headers((init as { headers?: HeadersInit })?.headers).entries()),
      body: String((init as { body?: string })?.body ?? ''),
    };
    calls.push(rec);
    const path = rec.url.split('/contents/')[1]!.split('?')[0]!;
    if (rec.method === 'GET') {
      if ((throws[path] ?? 0) > 0) { throws[path]!--; throw new Error('模拟 TimeoutError（AbortSignal.timeout）'); }
      const st = remote.get(path);
      if (!st) return jsonRes({ message: 'Not Found' }, 404);
      return jsonRes({ content: wrap(b64(st.text)), sha: st.sha });
    }
    const body = JSON.parse(rec.body);
    const sc = (scripts.get(path) ?? []).shift();
    if (sc?.status) {
      if (sc.conflictTo === 'sent') remote.set(path, { sha: `sha-${path}-race`, text: unb64(body.content) });
      else if (typeof sc.conflictTo === 'string') remote.set(path, { sha: `sha-${path}-race`, text: sc.conflictTo });
      return jsonRes({ message: 'failed to update ref', documentation_url: 'https://docs.github.com/rest' }, sc.status);
    }
    putSeq++;
    remote.set(path, { sha: `sha-${path}-put${putSeq}`, text: unb64(body.content) });
    return jsonRes({ commit: { html_url: `https://github.com/sjmw/noisedh-nav/commit/c${putSeq}`, sha: `c${putSeq}` } });
  }) as unknown as typeof fetch;
  const putsTo = (p: string) => calls.filter((c) => c.method === 'PUT' && c.url.includes(`/contents/${p}`));
  const putBodies = () => calls
    .filter((c) => c.method === 'PUT')
    .map((c) => { const b = JSON.parse(c.body); return { path: c.url.split('/contents/')[1]!, body: b, content: unb64(b.content) as string }; });
  return { calls, fetchImpl, remote, putsTo, putBodies };
};

const mkEnv = (extra: Partial<Env> = {}): Env =>
  ({ ADMIN_TOKEN: 't', GITHUB_TOKEN: 'ghtok', DEFAULT_TAXONOMY: '未分类', FAVICON_TEMPLATE: '', REPO: 'sjmw/noisedh-nav', DB: db, ...extra }) as unknown as Env;

const seed = async (url: string, status: 'pending' | 'published', title = '频道页面站', taxonomy = '频道页面') =>
  insertSite(db, { url, url_raw: url, title, description: '', logo: '', taxonomy, term: '', status, source: 'manual', sort: 0 });

// 独立重算「本次应写三文件」的字节（与 doPublish 的快照构建同纪律但各算各的，用于 skip 基线与 PUT 内容断言）
const expectedFiles = async (d: D1Database): Promise<{ ws: string; fl: string; nv: string }> => {
  const [published, pending, categories, flinks, navs] = await Promise.all([
    allPublishedRows(d), allPendingRows(d), allCategories(d), allFriendlinks(d), allNavitems(d),
  ]);
  const snapshot = [...published, ...pending.map((r) => ({ ...r, status: 'published' }))];
  return {
    ws: buildWebstackYml(snapshot, categories),
    fl: buildFriendlinksYml(flinks),
    nv: buildNavYml(navs),
  };
};

describe('doPublish（三文件发布：并行预检—幂等 skip—逐文件 PUT—冲突收敛）', () => {
  it('三文件全等 → 零 PUT、files 全 skip、pending 照常翻转（幂等短接的三文件版）', async () => {
    await seed('https://t0-pub.test/', 'published', 'T0已发站');
    await seed('https://t0-pend.test/', 'pending', 'T0待发站');
    const exp = await expectedFiles(db);
    const gh = mkGH({ initial: { [WS]: exp.ws, [FLP]: exp.fl, [NVP]: exp.nv } });
    const r = await doPublish(mkEnv(), db, gh.fetchImpl);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.files).toEqual([
        { path: WS, action: 'skip' }, { path: FLP, action: 'skip' }, { path: NVP, action: 'skip' },
      ]);
      expect(r.commitUrl).toBe('https://github.com/sjmw/noisedh-nav/blob/main/data/webstack.yml'); // 无新 commit 的兜底形状不变
      expect(r.friendlinks).toBe((await allFriendlinks(db)).length);
      expect(r.navitems).toBe((await allNavitems(db)).length);
    }
    expect(gh.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET']); // 三路预检，零 PUT
    expect((await getSiteByUrl(db, 'https://t0-pend.test/'))?.status).toBe('published'); // 全 skip 也翻转（发布即快照）
  });

  it('仅 webstack 变 → 只 PUT webstack.yml 一次；PUT 内容=含 pending 的快照字节；message 站点数格式不变', async () => {
    await seed('https://t1-pend.test/', 'pending', 'T1待发站');
    const exp = await expectedFiles(db);
    expect(exp.ws).toContain('T1待发站'); // 发布即快照：pending 进 webstack
    expect(exp.ws).toContain('T0已发站');
    const gh = mkGH({ initial: { [WS]: remoteYml(2), [FLP]: exp.fl, [NVP]: exp.nv } });
    const r = await doPublish(mkEnv(), db, gh.fetchImpl);
    expect(r.ok).toBe(true);
    const bodies = gh.putBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.path).toBe(WS);
    expect(bodies[0]!.content).toBe(exp.ws);
    expect(bodies[0]!.body.branch).toBe('main');
    expect(bodies[0]!.body.sha).toBe(`sha-${WS}-init`); // 预检 sha 透传（乐观锁）
    expect(bodies[0]!.body.message).toMatch(/^后台发布：\d+ 条站点（\d+ 条新增）$/);
    if (r.ok) {
      expect(r.files).toEqual([
        { path: WS, action: 'put' }, { path: FLP, action: 'skip' }, { path: NVP, action: 'skip' },
      ]);
      expect(r.commitUrl).toBe('https://github.com/sjmw/noisedh-nav/commit/c1');
      expect(r.count).toBe((await allPublishedRows(db)).length); // 翻转后 published 总数 = 快照数
    }
    expect((await getSiteByUrl(db, 'https://t1-pend.test/'))?.status).toBe('published');
  });

  it('仅 friendlinks 变 → 只 PUT friendlinks.yml（webstack/headers skip）；空表首推 + 独立计数字段', async () => {
    await insertFriendlink(db, { title: '友情链接一', url: 'https://fl-one.test', description: '示例友链', sort: 0 });
    await insertFriendlink(db, { title: '友情链接二', url: 'https://fl-two.test', description: '', sort: 1 });
    const parent = await insertNavitem(db, { item: '更多', icon: 'fas fa-ellipsis', link: '', parent_id: null, sort: 9 });
    await insertNavitem(db, { item: '子项甲', icon: '', link: 'https://kid-a.test', parent_id: parent.id, sort: 0 });
    const exp = await expectedFiles(db);
    expect(exp.fl).toContain('友情链接一');
    expect(exp.nv).toContain('子项甲'); // headers 已有真实内容作 skip 基线
    const gh = mkGH({ initial: { [WS]: exp.ws, [FLP]: '[]\n', [NVP]: exp.nv } });
    const r = await doPublish(mkEnv(), db, gh.fetchImpl);
    expect(r.ok).toBe(true);
    const bodies = gh.putBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.path).toBe(FLP);
    expect(bodies[0]!.content).toBe(exp.fl);
    expect(bodies[0]!.body.message).toMatch(/^后台发布：友情链接 \d+ 条$/);
    if (r.ok) {
      expect(r.files).toEqual([
        { path: WS, action: 'skip' }, { path: FLP, action: 'put' }, { path: NVP, action: 'skip' },
      ]);
      expect(r.friendlinks).toBe(2);
      expect(r.navitems).toBe(2);
    }
  });

  it('预检 404（三份远端都不存在）→ 新建式 PUT：body 不含 sha 键，三文件全 put', async () => {
    const exp = await expectedFiles(db);
    const gh = mkGH(); // 无 initial → 三路 GET 全 404
    const r = await doPublish(mkEnv(), db, gh.fetchImpl);
    expect(r.ok).toBe(true);
    const bodies = gh.putBodies();
    expect(bodies.map((b) => b.path)).toEqual([WS, FLP, NVP]); // 预检后按 webstack→friendlinks→headers 序写
    for (const b of bodies) expect('sha' in b.body).toBe(false); // 新建：sha 键整个缺席（ghPut sha 可空）
    expect(bodies[0]!.content).toBe(exp.ws);
    expect(bodies[1]!.content).toBe(exp.fl);
    expect(bodies[2]!.content).toBe(exp.nv);
    if (r.ok) expect(r.files.map((f) => f.action)).toEqual(['put', 'put', 'put']);
  });

  it('中途 409 对账不等：webstack PUT 成功后 friendlinks 409 → github_conflict；「1 个文件已更新」；headers 不再 PUT；pending 不翻转', async () => {
    await seed('https://t4-pend.test/', 'pending', 'T4待发站');
    const diverged = '- title: 外来友链\n  url: https://intruder.test\n';
    const gh = mkGH({
      initial: { [WS]: remoteYml(2), [FLP]: '[]\n', [NVP]: '[]\n' }, // 三份都有差异 → 本应逐份 PUT
      putScripts: { [FLP]: [{ status: 409, conflictTo: diverged }] },
    });
    const r = await doPublish(mkEnv(), db, gh.fetchImpl);
    expect(r).toMatchObject({ ok: false, code: 'github_conflict' });
    const msg = String((r as { message?: string }).message);
    expect(msg).toContain('发布中止于 data/friendlinks.yml');
    expect(msg).toContain('1 个文件已更新');
    expect(msg).toContain('2 个未更新');
    expect(msg).toContain('重试'); // 部分成功必须给出收敛指引（重发布幂等）
    expect(gh.putsTo(WS)).toHaveLength(1);
    expect(gh.putsTo(FLP)).toHaveLength(1); // 409 后只补对账 GET，绝不二次 PUT
    expect(gh.putsTo(NVP)).toHaveLength(0); // 中止剩余文件的 PUT
    expect((await getSiteByUrl(db, 'https://t4-pend.test/'))?.status).toBe('pending'); // 部分成功绝不翻转
  });

  it('409 对账相等 → 视为 skip 继续：余下 headers 照常 PUT、整体成功、pending 翻转、无第二次 PUT', async () => {
    await seed('https://t5-pend.test/', 'pending', 'T5待发站');
    const gh = mkGH({
      initial: { [WS]: remoteYml(2), [FLP]: '[]\n', [NVP]: '[]\n' },
      putScripts: { [FLP]: [{ status: 409, conflictTo: 'sent' }] }, // 并发者抢先推入与本次逐字节相同的内容
    });
    const r = await doPublish(mkEnv(), db, gh.fetchImpl);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.files).toEqual([
        { path: WS, action: 'put' }, { path: FLP, action: 'skip' }, { path: NVP, action: 'put' },
      ]);
      expect(r.commitUrl).toBe('https://github.com/sjmw/noisedh-nav/commit/c2'); // 最后一个新 commit（FL 未产生 commit 不计）
    }
    expect(gh.putsTo(FLP)).toHaveLength(1); // 仍无第二次 PUT
    expect((await getSiteByUrl(db, 'https://t5-pend.test/'))?.status).toBe('published');
  });

  it('webstack 首文件即 409 对账不等 → github_conflict（0 个已更新）；后续文件零 PUT；pending 不动', async () => {
    await seed('https://t6-pend.test/', 'pending', 'T6待发站');
    const exp = await expectedFiles(db);
    const gh = mkGH({
      initial: { [WS]: exp.ws + '# 别人加的注释\n', [FLP]: exp.fl, [NVP]: exp.nv },
      putScripts: { [WS]: [{ status: 409, conflictTo: remoteYml(1) }] },
    });
    const r = await doPublish(mkEnv(), db, gh.fetchImpl);
    expect(r).toMatchObject({ ok: false, code: 'github_conflict' });
    const msg = String((r as { message?: string }).message);
    expect(msg).toContain('0 个文件已更新');
    expect(msg).toContain('3 个未更新'); // 中止于首文件：三份都未落（含中止的那份）
    expect(gh.calls.filter((c) => c.method === 'PUT')).toHaveLength(1); // 中止后 FL/NV 不再尝试
    expect((await getSiteByUrl(db, 'https://t6-pend.test/'))?.status).toBe('pending');
  });

  it('GitHub 写失败（非 409，HTTP 500）→ fetch_failed；失败即停不重试；pending 完全不动', async () => {
    await seed('https://t7-pend.test/', 'pending', 'T7待发站');
    const exp = await expectedFiles(db);
    const gh = mkGH({ initial: { [WS]: remoteYml(2), [FLP]: exp.fl, [NVP]: exp.nv }, putScripts: { [WS]: [{ status: 500 }] } });
    const r = await doPublish(mkEnv(), db, gh.fetchImpl);
    expect(r).toMatchObject({ ok: false, code: 'fetch_failed' });
    expect(gh.calls.filter((c) => c.method === 'PUT')).toHaveLength(1); // §5.4 at-most-once：写失败不重试也不续写
    expect((await getSiteByUrl(db, 'https://t7-pend.test/'))?.status).toBe('pending');
  });

  it('首文件 GET 抛（超时/断网）→ ghGet 单次重试后照常发布；每文件 PUT 至多 1 次', async () => {
    await seed('https://t8-pend.test/', 'pending', 'T8待发站');
    const gh = mkGH({ initial: { [WS]: remoteYml(2), [FLP]: '[]\n', [NVP]: '[]\n' }, getThrows: { [WS]: 1 } });
    const r = await doPublish(mkEnv(), db, gh.fetchImpl);
    expect(r.ok).toBe(true);
    expect(gh.calls.filter((c) => c.method === 'GET' && c.url.includes(`/contents/${WS}`))).toHaveLength(2); // 抛出 1 次 + 重试 1 次
    expect(gh.calls.filter((c) => c.method === 'GET')).toHaveLength(4); // 3 路预检 + 1 次重试
    expect(gh.putBodies().map((b) => b.path)).toEqual([WS, FLP, NVP]); // 三路都变 → 各 PUT 恰一次
    if (r.ok) expect(r.files.map((f) => f.action)).toEqual(['put', 'put', 'put']);
    expect((await getSiteByUrl(db, 'https://t8-pend.test/'))?.status).toBe('published');
  });

  it('缺 GITHUB_TOKEN → fetch_failed 且零网络调用；REPO 未配置 → 落默认 sjmw/noisedh-nav', async () => {
    const empty = mkGH();
    const r = await doPublish(mkEnv({ GITHUB_TOKEN: '' as string }), db, empty.fetchImpl);
    expect(r).toMatchObject({ ok: false, code: 'fetch_failed' });
    expect(empty.calls).toHaveLength(0);
    const gh = mkGH();
    const r2 = await doPublish(mkEnv({ REPO: undefined as unknown as string }), db, gh.fetchImpl);
    expect(r2.ok).toBe(true);
    expect(gh.calls.some((c) => c.url.includes('repos/sjmw/noisedh-nav/contents/data/webstack.yml'))).toBe(true);
  });

  it('mixed taxonomy（同分类空/非空 term 混用）→ bad_request，零网络调用，pending 不动', async () => {
    const p1 = await seed('https://mix-a.test/', 'pending', '混A', '混用类');
    const p2 = await seed('https://mix-b.test/', 'pending', '混B', '混用类');
    await insertSite(db, { url: 'https://mix-c.test/', url_raw: 'https://mix-c.test/', title: '混C', description: '', logo: '', taxonomy: '混用类', term: '子项', status: 'pending', source: 'manual', sort: 0 });
    const gh = mkGH();
    const r = await doPublish(mkEnv(), db, gh.fetchImpl);
    expect(r).toMatchObject({ ok: false, code: 'bad_request' });
    expect(gh.calls).toHaveLength(0);
    for (const id of [p1.id, p2.id]) await deleteSite(db, id); // 清理，避免污染其它用例的全量快照
    await deleteSite(db, (await getSiteByUrl(db, 'https://mix-c.test/'))!.id);
  });
});

// ── 空库闸 + 骤降闸（独立空库，避免与上方累积共享快照互相干扰）──
// 两闸只对 data/webstack.yml 生效（binding ruling：friendlinks/headers 空表 → '[]\n' 是合法发布，R1 三文件后台单写）
const mfGate = new Miniflare({ log: new Log(LogLevel.ERROR), modules: true, script: 'export default{}', d1Databases: ['DB'], d1Persist: false });
let gdb: any;

// 远端假文件：n 条链接条目（buildWebstackYml 同款 `- title:` 行形态，供行计数正则粗计）
const remoteYml = (n: number): string =>
  '---\n' + Array.from({ length: n }, (_, i) => `- title: 远端站${i}\n  url: https://remote${i}.invalid\n`).join('');

const gateSeed = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++)
    await insertSite(gdb, { url: `https://gate${i}.invalid/`, url_raw: `https://gate${i}.invalid/`, title: `闸口站${i}`, description: '', logo: '', taxonomy: '闸口类', term: '', status: 'pending', source: 'manual', sort: 0 });
};
const gateClear = async (): Promise<void> => { await gdb.prepare('DELETE FROM sites').run(); await gdb.prepare('DELETE FROM categories').run(); };

// gate 库 friendlinks/navitems 恒空 → 两文件基线 '[]\n'（skip 掉，PUT 计数只反映 webstack）
const gateInitial = (ws: string): Record<string, string> => ({ [WS]: ws, [FLP]: '[]\n', [NVP]: '[]\n' });

describe('doPublish 保护闸（空库 + 50% 骤降，只对 webstack 快照生效）', () => {
  beforeAll(async () => {
    gdb = await mfGate.getD1Database('DB');
    await gdb.exec(readFileSync('schema.sql', 'utf8').replace(/--.*$/gm, '').replace(/\s+/g, ' '));
  });
  afterAll(async () => { await mfGate.dispose(); });

  it('空库（0 行）→ bad_request 拒绝且 GitHub 零请求（webstack 0 行 = 整体拒绝，三文件一份都不写）', async () => {
    await gateClear();
    const gh = mkGH();
    const r = await doPublish(mkEnv({ DB: gdb }), gdb, gh.fetchImpl);
    expect(r).toMatchObject({ ok: false, code: 'bad_request' });
    expect(String((r as { message?: string }).message)).toContain('没有任何站点');
    expect(gh.calls).toHaveLength(0); // 闸在预检 GET 之前：不烧任何 GitHub 请求
  });

  it('骤降闸：远端 webstack 100 条、快照 40 条 → 拒绝（消息含两数），PUT 零次，行不翻转', async () => {
    await gateClear();
    await gateSeed(40);
    const gh = mkGH({ initial: gateInitial(remoteYml(100)) });
    const r = await doPublish(mkEnv({ DB: gdb }), gdb, gh.fetchImpl);
    expect(r).toMatchObject({ ok: false, code: 'bad_request' });
    const msg = String((r as { message?: string }).message);
    expect(msg).toContain('40');
    expect(msg).toContain('100');
    expect(gh.calls.filter((c) => c.method === 'PUT')).toHaveLength(0); // 闸在 i===0：任何文件都不 PUT
    expect(gh.calls.filter((c) => c.method === 'GET')).toHaveLength(3); // 三路并行预检已发生
    const rows = await allPublishedRows(gdb);
    expect(rows).toHaveLength(0); // 发布即快照的翻转未发生
  });

  it('远端 100 条、快照 60 条 → 放行（未破 50% 线），webstack 恰一次 PUT，两新文件 skip', async () => {
    await gateClear();
    await gateSeed(60);
    const gh = mkGH({ initial: gateInitial(remoteYml(100)) });
    const r = await doPublish(mkEnv({ DB: gdb }), gdb, gh.fetchImpl);
    expect(r).toMatchObject({ ok: true, count: 60, friendlinks: 0, navitems: 0 });
    expect(gh.putBodies().map((b) => b.path)).toEqual([WS]);
  });

  it('远端仅 3 条、快照 1 条 → 放行（远端低于 20 条阈值不触发骤降闸）', async () => {
    await gateClear();
    await gateSeed(1);
    const gh = mkGH({ initial: gateInitial(remoteYml(3)) });
    const r = await doPublish(mkEnv({ DB: gdb }), gdb, gh.fetchImpl);
    expect(r).toMatchObject({ ok: true, count: 1 });
    expect(gh.putBodies().map((b) => b.path)).toEqual([WS]);
    await gateClear();
  });

  it('friendlinks 远端再大也不触发闸：远端 100 条 → 快照空表 ' + "'[]\\n'" + ' 照常 PUT（骤降闸只对 webstack 基线）', async () => {
    await gateClear();
    await gateSeed(1);
    const gh = mkGH({ initial: { [WS]: remoteYml(3), [FLP]: remoteYml(100), [NVP]: '[]\n' } });
    const r = await doPublish(mkEnv({ DB: gdb }), gdb, gh.fetchImpl);
    expect(r.ok).toBe(true); // 若闸误对 friendlinks 生效，这里会是 bad_request
    expect(gh.putBodies().map((b) => b.path)).toEqual([WS, FLP]); // friendlinks 100 条 → '[]\n' 属合法单写覆盖
  });
});
