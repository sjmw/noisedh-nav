// icon 决策链（spec-27 §5）：规则表纯函数可离线测；resolveIcon 的 AI 探测任何失败均回落规则表。
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_ICON, FA_CLASS, iconFor, resolveIcon } from '../src/icons';
import type { Env } from '../src/types';

describe('iconFor（关键词规则表）', () => {
  it('规则表命中（中/英、大小写）', () => {
    expect(iconFor('视频剪辑')).toBe('fas fa-film');
    expect(iconFor('Music 世界').startsWith('fas fa-')).toBe(true);
    expect(iconFor('AI合成')).toBe('fas fa-robot');
  });
  it('未命中 → 默认文件夹；规则命中即整类名（前缀 fas/far 按表）', () => {
    expect(iconFor('呸呸呸')).toBe(DEFAULT_ICON);
    expect(iconFor('游戏娱乐')).toBe('fas fa-gamepad'); // 命中即整条类名，不做拼接改写
  });
  it('比对序=表序先命中先赢：设计 排在 工具 前，「工具设计」落 fa-palette', () => {
    expect(iconFor('工具设计')).toBe('fas fa-palette');
  });
});

describe('FA_CLASS（类名白名单，防非类名串进前台模板）', () => {
  it('接受 fa/s/r/b 前缀词 + 空格 + fa-类名 + 可选尺寸后缀（正则按 brief 逐字落地）', () => {
    expect(FA_CLASS.test('fa fa-folder-open')).toBe(true);
    expect(FA_CLASS.test('fas fa-gamepad')).toBe(true);
    expect(FA_CLASS.test('far fa-heart')).toBe(true);
    expect(FA_CLASS.test('fab fa-github')).toBe(true);
    expect(FA_CLASS.test('fas fa-fire lg')).toBe(true); // brief 正则的尺寸后缀形态=' lg'（裸词）
    expect(FA_CLASS.test('fa-folder-open')).toBe(false); // 无前缀词裸名不收
    expect(FA_CLASS.test('fas fa-fire fa-6x')).toBe(false);
    expect(FA_CLASS.test('javascript:alert(1)')).toBe(false);
    expect(FA_CLASS.test('fas fa-gamepad onclick=x')).toBe(false);
    expect(FA_CLASS.test('')).toBe(false);
  });
});

describe('resolveIcon（AI 优先 → 规则表 → 默认）', () => {
  const env = { AI_BASE_URL: 'https://ai.test/v1/', AI_API_KEY: 'k', AI_MODEL: 'm' } as Env;
  const ok = (content: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
      { headers: { 'content-type': 'application/json' } })) as never;

  it('未配 AI 落规则表（零网络）；配 AI 且返回合法类名 → 用 AI；AI 返回非法/超时/非 200 → 落规则表', async () => {
    expect(await resolveIcon('游戏娱乐', {} as Env, ok({ icon: 'fas fa-gamepad' }))).toBe('fas fa-gamepad'); // 未配置：无请求
    expect(await resolveIcon('游戏娱乐', env, ok({ icon: 'far fa-gamepad' }))).toBe('far fa-gamepad');
    expect(await resolveIcon('游戏娱乐', env, ok({ icon: 'javascript:alert(1)' }))).toBe(iconFor('游戏娱乐'));
    expect(await resolveIcon('游戏娱乐', env, (async () => { throw new Error('net'); }) as never)).toBe(iconFor('游戏娱乐'));
  });
  it('未配置 AI：一次请求都不发；非 200/内容不合规同样零抛错落规则', async () => {
    const spy = vi.fn(async () => new Response('{}'));
    expect(await resolveIcon('呸呸呸', {} as Env, spy as unknown as typeof fetch)).toBe(DEFAULT_ICON);
    expect(spy).not.toHaveBeenCalled();
    expect(await resolveIcon('游戏娱乐', env, (async () => new Response('nope', { status: 500 })) as never)).toBe('fas fa-gamepad');
    expect(await resolveIcon('游戏娱乐', env, (async () => new Response(JSON.stringify({ choices: [] }))) as never)).toBe('fas fa-gamepad');
  });
  it('AI 请求契约：命中 ${base}/chat/completions，Bearer + json_object + UA + 超时 signal', async () => {
    const spy = vi.fn(ok({ icon: 'fas fa-gamepad' }));
    await resolveIcon('游戏', env, spy as unknown as typeof fetch);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('https://ai.test/v1/chat/completions');
    const headers = new Headers(init!.headers);
    expect(headers.get('authorization')).toBe('Bearer k');
    expect(headers.get('user-agent')).toBeTruthy(); // workerd 默认 UA 会被 CF 前置站点 403
    const body = JSON.parse(init!.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });
});
