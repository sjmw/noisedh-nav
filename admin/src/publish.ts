// 发布流程（spec §5）：读 D1 → 重建 webstack.yml → GitHub Contents GET(sha)→PUT。
// 发布即快照：所有 pending 行随本次 publish 置 published。
// 翻转时机 = PUT 成功「之后」（UPDATE sites … WHERE id IN 本次快照）：
//  - GitHub 写失败（网络/5xx/冲突中止）→ D1 状态完全不动，pending 仍是 pending；
//  - 构建时用「临时 published」的 pending 副本（不改 DB），保证写入内容与翻转后重导出的内容逐字节一致，
//    409 幂等比对（远端 vs 本次将写）也因此精确成立。
// 冲突语义（spec §5.4）：PUT 409 → 仅重 GET 对账，PUT 全程至多一次——
//  远端已等于本次内容 → 幂等成功；否则 github_conflict 中止（单一写入源被破坏时宁停不猜）。

import { buildWebstackYml } from './yml';
import { allPublishedRows, allPendingRows, allCategories, markPendingPublished } from './db';
import { ghGet, ghPut, GithubApiError } from './github';
import type { ErrCode } from './errors';
import type { Env } from './types';

const PATH = 'data/webstack.yml'; // friendlinks.yml 永不触碰（spec §5）
const DEFAULT_REPO = 'sjmw/noisedh-nav'; // spec §2.1 配置表给定仓库；REPO 未配置时落此默认

// 发布保护闸（终局评审 Important #1）：0 行闸 + 50% 骤降闸。
// 骤降闸对远端文本用行计数正则粗计条目数（`- title:` 行数）：刻意不引入 js-yaml 到运行时
// （零依赖全局约束），是「粗粒度上限守卫」——只拦明显异常的快照（宁拒不误推），误拒可人工复核后重试。
const MIN_REMOTE_FOR_RATIO_GATE = 20;
const countRemoteEntries = (text: string): number => (text.match(/^\s*- title:/gm) ?? []).length;

export type PublishResult =
  | { ok: true; commitUrl: string; count: number }
  | { ok: false; code: ErrCode; message: string };

export async function doPublish(
  env: Env,
  db: D1Database,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<PublishResult> {
  const token = env.GITHUB_TOKEN;
  if (!token) return { ok: false, code: 'fetch_failed', message: 'GITHUB_TOKEN 未配置，无法发布' };
  const repo = (env.REPO ?? '').trim() || DEFAULT_REPO;

  const [published, pending, categories] = await Promise.all([
    allPublishedRows(db),
    allPendingRows(db),
    allCategories(db),
  ]);
  const snapshot = [...published, ...pending.map((r) => ({ ...r, status: 'published' }))];

  let yml: string;
  try {
    yml = buildWebstackYml(snapshot, categories);
  } catch (e) {
    // 数据形态问题（如 taxonomy 混用两种形态）：修数据是人工的事，发布拒绝且不碰 GitHub
    return { ok: false, code: 'bad_request', message: (e as Error).message };
  }

  // 闸一（0 行）：置于 ghGet 之前——空库拒发不烧任何 GitHub 请求
  if (snapshot.length === 0) {
    return { ok: false, code: 'bad_request', message: 'D1 中没有任何站点，拒绝发布（疑似未灌种子或库被清空）' };
  }

  const message = `后台发布：${snapshot.length} 条站点（${pending.length} 条新增）`;
  let commitUrl: string;
  try {
    // ghGet 提前到骤降闸之前（闸二需要远端文本作对账基线）。PUT 至多一次与 409 仅重 GET 对账的姿态不变：
    // 本函数全程仍以「一次 GET → 至多一次 PUT（409 时补一次对账 GET）」为固定请求序列。
    const { sha, text: remoteText } = await ghGet(repo, PATH, token, fetchImpl);
    // 闸二（骤降）：远端条目数 ≥ 20 且快照不足其一半 → 疑似误清空/未灌种即发布，拒绝（消息含两个数字供人工对账）。
    // remoteCount 为粗粒度上限守卫（行计数而非 YAML 解析），误拒可人工复核后修数据重试，误放才是大事故，故取保守向。
    const remoteCount = countRemoteEntries(remoteText);
    if (remoteCount >= MIN_REMOTE_FOR_RATIO_GATE && snapshot.length * 2 < remoteCount) {
      return { ok: false, code: 'bad_request', message: `快照仅 ${snapshot.length} 条站点，不足远端 ${remoteCount} 条的一半，疑似误发布，已拒绝（请核对 D1 数据后重试）` };
    }
    try {
      commitUrl = (await ghPut(repo, PATH, yml, sha, message, token, fetchImpl)).commitUrl;
    } catch (e) {
      if (e instanceof GithubApiError && e.status === 409) {
        // sha 过期：重新 GET 对账。zero-dep 下「深比较」= 字节级相等：
        // 内容出自确定性生成器，同输入必同字节，远端等于本次将写即「远端已是本次发布的结果」。
        const fresh = await ghGet(repo, PATH, token, fetchImpl);
        if (fresh.text !== yml) {
          return { ok: false, code: 'github_conflict', message: '远端 webstack.yml 存在非本次发布的改动，已中止发布（单一写入源假设被破坏，请人工合并后重试）' };
        }
        // 远端内容已等于本次将写 → 视为幂等成功；commitUrl 指向 main 上的该文件
        commitUrl = `https://github.com/${repo}/blob/main/${PATH}`;
      } else {
        throw e;
      }
    }
  } catch (e) {
    // GithubApiError 消息只含 status/path，不含 token/正文 —— 可安全落日志
    console.error('publish: GitHub 读写失败:', e instanceof Error ? e.message : e);
    return { ok: false, code: 'fetch_failed', message: 'GitHub 读写失败，发布未生效' };
  }

  // 成功才翻转：仅本次快照内的 pending 行（id 清单），窗口期新增 pending 不受影响
  await markPendingPublished(db, pending.map((r) => r.id));
  return { ok: true, commitUrl, count: snapshot.length }; // count = 写入 yml 中的（发布后）链接总数
}
