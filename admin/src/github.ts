// GitHub Contents API 读写（spec §5）。零 npm 运行时依赖，仅用 Worker 全局（fetch/atob/btoa/TextEncoder）。
// 本模块存在的核心理由是修正扩展的 UTF-8 坑：
//  - 解码：GitHub 返回 base64（且带 ~76 字符换行）。plain atob 产出 latin1 串，中文必坏——
//    必须 atob → Uint8Array.charCodeAt → TextDecoder('utf-8')，且 atob 前先剥空白。
//  - 编码：TextEncoder 得 UTF-8 字节 → 分块（0x8000）拼二进制串 → btoa。
//    String.fromCharCode(...bytes) 整体展开在 ~50KB+ yml（真实 webstack.yml 即在此量级）上有实参个数溢出风险。

export class GithubApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'GithubApiError';
  }
}

const GH_API = 'https://api.github.com';
const CHUNK = 0x8000; // 32768：String.fromCharCode 安全实参上限的保守值

// spec §8：外部调用带超时（GitHub 慢/挂起时不吊死 isolate）；GET 另有单次重试（spec §8「超时与单次重试」）——
// 读操作幂等，重试安全；写操作刻意不重试（spec §5.4：publish 的 PUT 任何情况下只发一次），ghPut 不走该路径。
const TIMEOUT_MS = 15_000;

const ghHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`, // 任何日志/错误消息均不携带该头
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});

export function b64DecodeUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, '')); // GitHub 的 content 带换行，先剥空白
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

export function b64EncodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK)); // 分块展开，避免大文件溢出
  }
  return btoa(bin);
}

/** GET /repos/{repo}/contents/{path}?ref=main → 解码后的文件文本 + 当前 sha（PUT 乐观锁用）。
 *  spec §8 单次重试：仅限瞬时失败（fetch 抛出=网络/超时，或 5xx）——GET 幂等，重试安全；
 *  4xx（凭据/路径错误）为确定性失败不重试；PUT（ghPut）维持 at-most-once（spec §5.4），不经此路径。 */
export async function ghGet(
  repo: string,
  path: string,
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ text: string; sha: string }> {
  try {
    return await ghGetOnce(repo, path, token, fetchImpl);
  } catch (e) {
    const transient = !(e instanceof GithubApiError) || e.status >= 500;
    if (!transient) throw e;
    return ghGetOnce(repo, path, token, fetchImpl);
  }
}

async function ghGetOnce(
  repo: string,
  path: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ text: string; sha: string }> {
  const url = `${GH_API}/repos/${repo}/contents/${path}?ref=main`;
  const res = await fetchImpl(url, { headers: ghHeaders(token), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new GithubApiError(res.status, `GitHub GET 失败：HTTP ${res.status} ${path}`);
  const data = (await res.json()) as { content?: unknown; sha?: unknown };
  if (typeof data.content !== 'string' || typeof data.sha !== 'string') {
    throw new GithubApiError(0, 'GitHub GET 响应缺少 content/sha 字段');
  }
  return { text: b64DecodeUtf8(data.content), sha: data.sha };
}

/** PUT 同路径写文件（branch=main + sha 乐观锁）；非 2xx 一律抛 GithubApiError（409 由调用方按 spec §5.4 处理） */
export async function ghPut(
  repo: string,
  path: string,
  text: string,
  sha: string,
  message: string,
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ commitUrl: string }> {
  const url = `${GH_API}/repos/${repo}/contents/${path}`;
  const body = JSON.stringify({ message, content: b64EncodeUtf8(text), branch: 'main', sha });
  const res = await fetchImpl(url, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // 409 的 GitHub body 形如 {message, documentation_url}：仅取 status 分类，消息不带 body 以免噪音
    throw new GithubApiError(res.status, `GitHub PUT 失败：HTTP ${res.status} ${path}`);
  }
  const data = (await res.json()) as { commit?: { html_url?: unknown } };
  const commitUrl = data.commit?.html_url;
  if (typeof commitUrl !== 'string') throw new GithubApiError(0, 'GitHub PUT 响应缺少 commit.html_url');
  return { commitUrl };
}
