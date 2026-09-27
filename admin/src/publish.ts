// 发布流程（spec §5 + 管理扩展轮 spec-27 §4）：读 D1 → 重建三份 yml → GitHub Contents 并行预检 GET → 逐文件 PUT。
//   data/webstack.yml（sites）/ data/friendlinks.yml（friendlinks）/ data/headers.yml（navitems）
// 发布即快照：所有 pending 行随本次 publish 置 published——且仅在「三份文件全部成功」之后才翻转；
//  任一文件写失败/冲突中止 → D1 状态完全不动（部分成功宁可留 pending，重试发布按内容比对收敛）。
// PUT 至多一次/文件（spec §5.4）：409 → 仅补一次对账 GET——
//  远端已等于本次将写 → 该文件按 skip 语义收编并继续；不等 → PublishConflictAbort 中止剩余 PUT（单一写入源被破坏时宁停不猜）。
// 保护闸只对 webstack 快照生效：0 行闸在三路预检之前（拒绝即整体拒绝，零 GitHub 请求）；
//  骤降闸以远端 webstack 为基线；friendlinks/headers 空表发布 '[]\n' 合法（R1：三文件由后台单写）。
// 幂等短接（三文件版）：远端逐字节 = 本次将写 → 该文件不发 PUT、记 skip；三份全 skip 仍照常翻转 pending。

import { buildWebstackYml, buildFriendlinksYml, buildNavYml } from './yml';
import {
  allPublishedRows, allPendingRows, allCategories, markPendingPublished,
  allFriendlinks, allNavitems,
} from './db';
import { ghGet, ghPut, GithubApiError } from './github';
import type { ErrCode } from './errors';
import type { Env } from './types';

const PATH = 'data/webstack.yml';
const FL_PATH = 'data/friendlinks.yml';
const NAV_PATH = 'data/headers.yml';
const DEFAULT_REPO = 'sjmw/noisedh-nav'; // spec §2.1 配置表给定仓库；REPO 未配置时落此默认

// 发布保护闸（终局评审 Important #1）：0 行闸 + 50% 骤降闸（均只对 webstack）。
// 骤降闸对远端文本用行计数正则粗计条目数（`- title:` 行数）：刻意不引入 js-yaml 到运行时
// （零依赖全局约束），是「粗粒度上限守卫」——只拦明显异常的快照（宁拒不误推），误拒可人工复核后重试。
const MIN_REMOTE_FOR_RATIO_GATE = 20;
const countRemoteEntries = (text: string): number => (text.match(/^\s*- title:/gm) ?? []).length;

type YmlFile = { path: string; content: string };
type FileAction = { path: string; action: 'put' | 'skip' };
type Remote = { sha: string | null; text: string | null }; // 预检结果：text=null = 远端不存在该 path（GET 404 → 新建式 PUT）

export type PublishResult =
  | { ok: true; commitUrl: string; count: number; friendlinks: number; navitems: number; files: FileAction[] }
  | { ok: false; code: ErrCode; message: string };

/** 409 对账不等的中止信号：ghPutWithReconcile 抛出，doPublish 捕获后中止剩余 PUT 并回 github_conflict（绝不翻转 pending）。 */
class PublishConflictAbort extends Error {
  constructor(readonly filePath: string, message: string) {
    super(message);
    this.name = 'PublishConflictAbort';
  }
}

/** 逐文件 PUT + 409 对账语义封装（spec §5.4，单文件版姿态平移到每份文件）：
 *  成功 → 新 commit URL；409 且对账相等 → skip 语义（blob URL，无新 commit，视为该文件已收敛）；
 *  409 且对账不等 → PublishConflictAbort；非 409 的 GithubApiError 原样上抛（调用方归 fetch_failed）。 */
async function ghPutWithReconcile(
  repo: string,
  f: YmlFile,
  sha: string | null,
  message: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ commitUrl: string; skipped: boolean }> {
  try {
    const { commitUrl } = await ghPut(repo, f.path, f.content, sha, message, token, fetchImpl);
    return { commitUrl, skipped: false };
  } catch (e) {
    if (e instanceof GithubApiError && e.status === 409) {
      // sha 过期：重新 GET 对账。zero-dep 下「深比较」= 字节级相等：
      // 内容出自确定性生成器，同输入必同字节，远端等于本次将写即「远端已是本次发布的结果」。
      const fresh = await ghGet(repo, f.path, token, fetchImpl);
      if (fresh.text !== f.content) {
        throw new PublishConflictAbort(f.path, `远端 ${f.path} 存在非本次发布的改动（单一写入源假设被破坏，请人工合并后重试）`);
      }
      return { commitUrl: `https://github.com/${repo}/blob/main/${f.path}`, skipped: true };
    }
    throw e;
  }
}

export async function doPublish(
  env: Env,
  db: D1Database,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<PublishResult> {
  const token = env.GITHUB_TOKEN;
  if (!token) return { ok: false, code: 'fetch_failed', message: 'GITHUB_TOKEN 未配置，无法发布' };
  const repo = (env.REPO ?? '').trim() || DEFAULT_REPO;

  const [published, pending, categories, flinks, navs] = await Promise.all([
    allPublishedRows(db),
    allPendingRows(db),
    allCategories(db),
    allFriendlinks(db),
    allNavitems(db),
  ]);
  const snapshot = [...published, ...pending.map((r) => ({ ...r, status: 'published' }))];

  let yml: string;
  try {
    yml = buildWebstackYml(snapshot, categories);
  } catch (e) {
    // 数据形态问题（如 taxonomy 混用两种形态）：修数据是人工的事，发布拒绝且不碰 GitHub
    return { ok: false, code: 'bad_request', message: (e as Error).message };
  }

  // 闸一（0 行，仅 webstack）：置于三路预检之前——空库拒发不烧任何 GitHub 请求，三份文件一份都不写
  if (snapshot.length === 0) {
    return { ok: false, code: 'bad_request', message: 'D1 中没有任何站点，拒绝发布（疑似未灌种子或库被清空）' };
  }

  const files: YmlFile[] = [
    { path: PATH, content: yml },
    { path: FL_PATH, content: buildFriendlinksYml(flinks) },
    { path: NAV_PATH, content: buildNavYml(navs) },
  ];
  // 逐文件 commit message：webstack 维持旧格式（审计连贯），两新文件各自报条目数
  const fileMessage = (f: YmlFile): string =>
    f.path === PATH ? `后台发布：${snapshot.length} 条站点（${pending.length} 条新增）`
      : f.path === FL_PATH ? `后台发布：友情链接 ${flinks.length} 条`
        : `后台发布：顶部导航 ${navs.length} 项`;

  let lastCommitUrl = '';
  const actions: FileAction[] = [];
  try {
    // 预检阶段：三路并行 GET 全部完成后才开始任何 PUT（闸二需要远端现文作基线；skip 判定需要远端字节）。
    // 404 视作「需要新建」：sha/text 皆 null，PUT 时整个省略 sha 键（ghPut 的 string|null 支持）。
    const remotes: Remote[] = await Promise.all(files.map(async (f): Promise<Remote> => {
      try {
        const r = await ghGet(repo, f.path, token, fetchImpl);
        return { sha: r.sha, text: r.text };
      } catch (e) {
        if (e instanceof GithubApiError && e.status === 404) return { sha: null, text: null };
        throw e;
      }
    }));
    // 写入阶段：按序逐文件（webstack → friendlinks → headers），内容比对幂等短接（等 → skip 不发 PUT）
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!, remote = remotes[i]!;
      if (i === 0 && remote.text !== null) {
        // 闸二（骤降，仅 webstack）：远端条目数 ≥ 20 且快照不足其一半 → 疑似误清空/未灌种即发布，拒绝。
        // remoteCount 为粗粒度上限守卫（行计数而非 YAML 解析），误拒可人工复核后修数据重试，误放才是大事故，故取保守向。
        const remoteCount = countRemoteEntries(remote.text);
        if (remoteCount >= MIN_REMOTE_FOR_RATIO_GATE && snapshot.length * 2 < remoteCount) {
          return { ok: false, code: 'bad_request', message: `快照仅 ${snapshot.length} 条站点，不足远端 ${remoteCount} 条的一半，疑似误发布，已拒绝（请核对 D1 数据后重试）` };
        }
      }
      if (remote.text === f.content) {
        // 同 sha PUT 相同内容的 GitHub 行为未验证，且会留空 commit 噪音——不发 PUT，记 skip。
        actions.push({ path: f.path, action: 'skip' });
        continue;
      }
      const r = await ghPutWithReconcile(repo, f, remote.sha, fileMessage(f), token, fetchImpl);
      if (!r.skipped) lastCommitUrl = r.commitUrl;
      actions.push({ path: f.path, action: r.skipped ? 'skip' : 'put' }); // 409 对账相等 → 视为 skip 继续
    }
  } catch (e) {
    if (e instanceof PublishConflictAbort) {
      // 部分成功：已写的收在远端，未写的不碰。不翻转 pending（发布即快照要求三文件齐落），重试点发布按内容比对收敛。
      const done = actions.filter((a) => a.action === 'put').length;
      return { ok: false, code: 'github_conflict', message: `发布中止于 ${e.filePath}：${done} 个文件已更新，${files.length - actions.length} 个未更新。重试点发布可收敛（内容比对幂等）。${e.message}` };
    }
    // GithubApiError 消息只含 status/path，不含 token/正文 —— 可安全落日志
    console.error('publish: GitHub 读写失败:', e instanceof Error ? e.message : e);
    return { ok: false, code: 'fetch_failed', message: 'GitHub 读写失败，发布未生效' };
  }

  // 成功（三份全部 put/skip 落定）才翻转：仅本次快照内的 pending 行（id 清单），窗口期新增 pending 不受影响
  await markPendingPublished(db, pending.map((r) => r.id));
  // count = 写入 webstack.yml 中的（发布后）链接总数；commitUrl = 本次最后一个新 commit（全 skip 时兜底指向 main 上的文件）
  return {
    ok: true,
    commitUrl: lastCommitUrl || `https://github.com/${repo}/blob/main/${PATH}`,
    count: snapshot.length,
    friendlinks: flinks.length,
    navitems: navs.length,
    files: actions,
  };
}
