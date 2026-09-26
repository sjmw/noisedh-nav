import { describe, it, expect } from 'vitest';
import { requireAuth } from '../src/auth';
const mk = (tok?: string) => new Request('https://x/api/admin/sites', tok ? { headers: { Authorization: `Bearer ${tok}` } } : {});
describe('requireAuth', () => {
  const env = { ADMIN_TOKEN: 's3cret-long-random' } as any;
  it('正确 token 通过', () => expect(requireAuth(mk('s3cret-long-random'), env)).toBe(true));
  it('缺失/错误 token 拒绝', () => {
    expect(requireAuth(mk(), env)).toBe(false);
    expect(requireAuth(mk('wrong'), env)).toBe(false);
    expect(requireAuth(mk('s3cret-long-rando'), env)).toBe(false); // 长度差 1
  });
});
