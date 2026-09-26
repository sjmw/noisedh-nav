import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '../src/url';
describe('normalizeUrl', () => {
  it('补协议、小写 host、去尾斜杠', () => {
    expect(normalizeUrl('WWW.Example.COM/Path/')).toBe('https://www.example.com/Path');
    expect(normalizeUrl('example.com')).toBe('https://example.com');
  });
  it('剥跟踪参数保留业务参数', () => {
    expect(normalizeUrl('https://a.cn/p?utm_source=x&id=7#g')).toBe('https://a.cn/p?id=7#g');
    expect(normalizeUrl('https://a.cn/p?spm=1.2&gclid=y&from=z&ref=w&a=1')).toBe('https://a.cn/p?a=1');
  });
  it('非法输入返回 null', () => { expect(normalizeUrl('not a url')).toBeNull(); expect(normalizeUrl('')).toBeNull(); });
  it('端口与查询保序', () => {
    expect(normalizeUrl('http://a.cn:8080/x?b=2&a=1')).toBe('http://a.cn:8080/x?b=2&a=1');
  });
});
