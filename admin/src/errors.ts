export const CODES = ['unauthorized', 'bad_request', 'dup_url', 'fetch_failed', 'ai_invalid', 'github_conflict', 'too_large'] as const;
export type ErrCode = (typeof CODES)[number];
export function jsonError(code: ErrCode, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: code, message }), { status, headers: { 'Content-Type': 'application/json' } });
}
