export function requireAuth(req: Request, env: { ADMIN_TOKEN: string }): boolean {
  const got = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const want = env.ADMIN_TOKEN;
  if (!want || got.length !== want.length) return false;
  const enc = new TextEncoder();
  return crypto.subtle.timingSafeEqual(enc.encode(got), enc.encode(want));
}
