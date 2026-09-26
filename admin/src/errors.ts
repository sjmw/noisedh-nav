export const CODES = ['unauthorized', 'bad_request', 'dup_url', 'fetch_failed', 'ai_invalid', 'github_conflict', 'too_large'] as const;
export type ErrCode = (typeof CODES)[number];
export function jsonError(code: ErrCode, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: code, message }), { status, headers: { 'Content-Type': 'application/json' } });
}

// 错误码 → HTTP 状态映射。终局评审 minor-5：原 routes.ts 的 errByCode 与 extension.ts 的 errStatus
// 逐字重复，统一收口于此（纯搬移，零行为变化）。
export const errStatus: Record<ErrCode, number> = {
  unauthorized: 401, bad_request: 400, dup_url: 409, fetch_failed: 502,
  ai_invalid: 502, github_conflict: 409, too_large: 413,
};

// JSON 对象请求体解析：非对象/数组/解析失败一律 null（调用方转 400 信封）。
// 终局评审 minor-5：原 routes.ts 与 extension.ts 各有一份逐字实现，统一收口。
export async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await req.json();
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
