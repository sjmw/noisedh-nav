import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { aiAnalyze, type AiResult } from '../src/ai';

const env = { AI_BASE_URL: 'https://x/v1', AI_API_KEY: 'k', AI_MODEL: 'm' } as any;
const fakeFetch = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
const input = { url: 'https://cg99.com', pageText: 'CG 设计资源站', baselineTitle: 'CG99', categories: ['媒体创作'] };

// fixtures 为活测试数据：ok=合规定级载荷 / bad-json=content 非 JSON / unknown-taxonomy=分类不在列表且 new_category=false
const fixture = (name: string) => JSON.parse(readFileSync(`test/fixtures/ai/${name}.json`, 'utf8'));
// 便捷构造：给定 AI 输出的 JSON 字符串（或任意 content）包装成 OpenAI 兼容响应
const contentOf = (c: string) => ({ choices: [{ message: { content: c } }] });

describe('aiAnalyze', () => {
  it('合法 JSON 解析为结果', async () => {
    const r = await aiAnalyze(input, env, fakeFetch(fixture('ok')));
    expect(r).toEqual({ title: 'CG99', description: 'CG设计资源', taxonomy: '媒体创作', term: '素材', newCategory: false } satisfies AiResult);
  });
  it('非 JSON / 字段缺失 / 未知分类且非 new_category → null', async () => {
    expect(await aiAnalyze(input, env, fakeFetch(fixture('bad-json')))).toBeNull();
    expect(await aiAnalyze(input, env, fakeFetch(contentOf('{"title":"t"}')))).toBeNull();
    expect(await aiAnalyze(input, env, fakeFetch(fixture('unknown-taxonomy')))).toBeNull();
  });
  it('未配置 AI → null 且不发请求', async () => {
    let called = false;
    expect(await aiAnalyze(input, {} as any, (async () => { called = true; return new Response('{}'); }) as any)).toBeNull();
    expect(called).toBe(false);
  });

  // ---- 以下为 brief 之外的补充用例（严格校验边界 + 请求契约） ----
  it('未知分类但 new_category=true 时放行', async () => {
    const r = await aiAnalyze(input, env, fakeFetch(contentOf('{"title":"t","description":"d","taxonomy":"外星分类","term":"","new_category":true}')));
    expect(r).toEqual({ title: 't', description: 'd', taxonomy: '外星分类', term: '', newCategory: true });
  });
  it('term 缺失 → null；term 为空串（存在）→ 合法', async () => {
    expect(await aiAnalyze(input, env, fakeFetch(contentOf('{"title":"t","description":"d","taxonomy":"媒体创作","new_category":false}')))).toBeNull();
    const r = await aiAnalyze(input, env, fakeFetch(contentOf('{"title":"t","description":"d","taxonomy":"媒体创作","term":"","new_category":false}')));
    expect(r?.term).toBe('');
  });
  it('字段类型错（taxonomy 为数字 / new_category 非布尔）→ null', async () => {
    expect(await aiAnalyze(input, env, fakeFetch(contentOf('{"title":"t","description":"d","taxonomy":123,"term":"","new_category":false}')))).toBeNull();
    expect(await aiAnalyze(input, env, fakeFetch(contentOf('{"title":"t","description":"d","taxonomy":"媒体创作","term":"","new_category":"false"}')))).toBeNull();
  });
  it('content 是合法 JSON 但非对象（"5" / null / 数组）→ null', async () => {
    for (const c of ['5', 'null', '[{"title":"t"}]']) {
      expect(await aiAnalyze(input, env, fakeFetch(contentOf(c)))).toBeNull();
    }
  });
  it('超长 title(>30字) / description(>40字) 整条降级为 null（不截断半采信）', async () => {
    expect(await aiAnalyze(input, env, fakeFetch(contentOf(`{"title":"${'标'.repeat(31)}","description":"d","taxonomy":"媒体创作","term":"","new_category":false}`)))).toBeNull();
    expect(await aiAnalyze(input, env, fakeFetch(contentOf(`{"title":"t","description":"${'述'.repeat(41)}","taxonomy":"媒体创作","term":"","new_category":false}`)))).toBeNull();
    // 恰好 30/40 字边界放行
    expect(await aiAnalyze(input, env, fakeFetch(contentOf(`{"title":"${'标'.repeat(30)}","description":"${'述'.repeat(40)}","taxonomy":"媒体创作","term":"","new_category":false}`)))).not.toBeNull();
  });
  it('响应结构不合规（无 choices / content 非字符串）→ null', async () => {
    expect(await aiAnalyze(input, env, fakeFetch({}))).toBeNull();
    expect(await aiAnalyze(input, env, fakeFetch({ choices: [{ message: {} }] }))).toBeNull();
  });
  it('网络异常：重试一次后 null；首次失败重试成功则出结果', async () => {
    const alwaysFail = vi.fn(async () => { throw new Error('network down'); });
    expect(await aiAnalyze(input, env, alwaysFail as unknown as typeof fetch)).toBeNull();
    expect(alwaysFail).toHaveBeenCalledTimes(2);

    let calls = 0;
    const ok = fixture('ok');
    const flaky = vi.fn(async () => { if (++calls === 1) throw new Error('transient'); return new Response(JSON.stringify(ok)); });
    expect(await aiAnalyze(input, env, flaky as unknown as typeof fetch)).not.toBeNull();
    expect(flaky).toHaveBeenCalledTimes(2);
  });
  it('非 ok 状态重试一次后 null', async () => {
    const fake = vi.fn(async () => new Response('nope', { status: 500 }));
    expect(await aiAnalyze(input, env, fake as unknown as typeof fetch)).toBeNull();
    expect(fake).toHaveBeenCalledTimes(2);
  });
  it('POST 命中 ${base}/chat/completions，携带 model/temperature 0/json_object/Bearer', async () => {
    const fake = vi.fn(async (_u: string | URL, _init?: RequestInit) => new Response(JSON.stringify(fixture('ok'))));
    await aiAnalyze(input, env, fake as unknown as typeof fetch);
    const [url, init] = fake.mock.calls[0]!;
    expect(url).toBe('https://x/v1/chat/completions');
    expect(init!.method).toBe('POST');
    const headers = new Headers(init!.headers);
    expect(headers.get('authorization')).toBe('Bearer k');
    expect(headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe('m');
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages.map((m: any) => m.role)).toEqual(['system', 'user']);
    expect(body.messages[0].content).toContain('仅输出 JSON');
    expect(body.messages[0].content).toContain('媒体创作'); // categories 注入 system
    expect(body.messages[1].content).toContain('https://cg99.com');
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });
  it('任一 env 字段缺失 → null 且不发请求', async () => {
    for (const partial of [
      { AI_BASE_URL: 'https://x/v1', AI_API_KEY: 'k' },
      { AI_BASE_URL: 'https://x/v1', AI_MODEL: 'm' },
      { AI_API_KEY: 'k', AI_MODEL: 'm' },
    ]) {
      let called = false;
      expect(await aiAnalyze(input, partial as any, (async () => { called = true; return new Response('{}'); }) as any)).toBeNull();
      expect(called).toBe(false);
    }
  });
});
