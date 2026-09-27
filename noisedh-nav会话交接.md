# noisedh-nav 部署方案 — 会话交接（下次打开先读这份）

> 整理日期：2026-09-26
> 目的：下一场会话不必依赖聊天记录即可接着干。
> 当前工作稿：尚无（本轮只做调研与验证，未修改任何项目文件）

## 1. 任务是什么

为 `/home/wzy/Desktop/mynav/noisedh-nav`（Hugo 导航站）确定部署方案：前台放 Cloudflare Pages，收藏/管理链路怎么接。角色是方案分析与可行性核实，交付物是已拍板的口径 + 一份待落地清单。代码改动尚未开始。

## 2. 必须遵守的约束

1. 核心诉求是**随时随地访问自己收藏的网站**，导航优先，不是博客/文章站。
2. **不想花钱**。
3. 用户本地网络访问 GitHub 很慢、经常超时。
4. 收藏频率低，**按周计**，不是每天。
5. 用户**有一台自己的服务器，能直连 GitHub**。
6. 后台地址要**可配置**（用户原话：放在 Cloudflare 的某个配置里），不能改一次地址就重新构建一次。
7. **后端没起来时，单纯前台也必须能用**。

## 3. 依据材料

| 材料 | 路径/说明 | 本任务里怎么用 |
|------|-----------|----------------|
| 站点配置 | `config.toml` | `theme`、`baseURL`、`publishDir="docs"`、`[outputs] home`、后端 URL 占位符 |
| 静态搜索索引 | `themes/noisedh-nav-v2/layouts/index.searchindex.json`、`partials/component_header/search_index_data.html` | 证明搜索是构建期产物，数据来自 `data/webstack.yml` + `friendlinks.yml` |
| 前端行为 | `themes/noisedh-nav-v2/static/assets/js/component_header.js` | 搜索触发（:80/:81/:562）、统计 local（:158）、最近收录降级（:193-215） |
| v1 主题 | `themes/noisedh-nav-v1/`（含其自带 `config.toml`） | 主题切换可行性与功能差异对比 |
| 后端 | `extension/yaml-server/server.js`（9489 行） | `fs` 依赖统计、`cors({origin:'*'})`（:200）、`runGitSync`（:1311-1330）、git 同步 env（:22-26） |
| 扩展 | `extension/Nav-manage-extension/popup.js` | GitHub 模式（:277/:290/:302）与云服务器模式（:1195）调用差异 |
| 文档 | `README.md`、`extension/README.md`、`extension/yaml-server/DEPLOYMENT.md` | Railway 段、MCP、前后端分离策略；**其中数处与仓库实际不符** |

## 4. 当前进度

已完成：用本机 `hugo v0.131.0+extended` 起过开发服务器（127.0.0.1:1313）并验证首页渲染、搜索实测（输入 "GitHub" 返回 40 条结果）；构建过 v1 主题产物做对比；查清 Cloudflare / Railway 两个平台的当前能力与收费。

已清理：两个服务（1313 hugo、1314 静态）已停止，端口释放；`docs/`、`.hugo_build.lock`、`/tmp/build-v1`、`/tmp/build-v2`、`/tmp/v1test` 及相关日志已删除。`git status` 回到干净状态，`main` 与 `origin/main` 齐平。

未开始：任何代码或配置修改。

## 5. 已拍板的事实

**仓库构成**：这是 monorepo，`README.md:72` 自述"包含 Hugo 站点（主题）+ 后端 API + 浏览器扩展"。后端和扩展代码**本来就都在本地**（`extension/yaml-server/` 612K、`extension/Nav-manage-extension/` 216K），随 clone 一起进来，不是子模块。用户最初以为只拉了前端，这点已澄清。

**读路径 100% 静态**：导航分类内容构建期渲染进 HTML；搜索索引是构建产物；收录数由 `statisticsMode="local"` 时前端从索引去重算出。所以约束 7 天然成立，不需要额外实现。

**部署方案（已定）**：前台 Cloudflare Pages + 后台 `yaml-server` 跑在用户自己那台服务器上。

**排除 Cloudflare 跑后端**：官方容器文档明确 "All disk is ephemeral"，无持久卷（快照仅 coming soon），实例空闲自动休眠、唤醒后是回到镜像状态的新磁盘。该后端的数据模型正是磁盘上的 git 工作树 + YAML，`runGitSync` push 失败后本地 commit 会永久消失。Workers/Pages Functions 路线则要绕过 110+ 处 `fs` 调用（34 `existsSync`、15 `readFileSync`、13 `writeFileSync`、9 `mkdirSync`、4 `renameSync` 等），属重写而非移植。

**排除 Railway**：Free 档只有 **$1/月**用量额度，容器按秒计量且服务常驻，空转 Node 服务大概就在 $1 上下——属"可能刚好超一点"的边界，超出即需绑卡，不是稳定免费。且文档里"仓库已内置 `railway.json`"是假的：该文件不存在，`git log --all -- railway.json` 无记录；同段文档指向的仓库 `rcy1314/noisedh` 也与实际 remote `rcy1314/noisedh-nav` 不符。Railway 确实有 Volume（这点强于 Cloudflare），但相对用户已有的服务器无净收益，且 `*.up.railway.app` 在国内可达性未验证——用户的动机恰恰是网络受限。

**排除扩展的 GitHub 模式**：`githubGetFile` 用 `atob`（latin1）解码（popup.js:298），`base64EncodeUtf8` 用 `TextEncoder`（UTF-8）编码（popup.js:322），编解码不对称。已在 node 中用示例字符串验证该往返**不幂等**：53 字节变 65 字节，`频道页面` 变 `é¢åé¡µé¢`。由于是整文件读-改-写，每次收藏会把全文重编码一层，378 条近全中文数据持续劣化。另：`https://api.github.com` 三处硬编码、无 API base 配置项，接不上镜像或代理；单次收藏约 234KB 往返，且无 timeout/retry/AbortController；stale `sha` 直接 409 且无重取逻辑。（编码不幂等已实测；"写坏文件"是由代码路径推出，未真实连仓库跑过。）

**主题：留在 v2**。`themes/noisedh-nav-v1/config.toml` 不是主题清单（Hugo 主题清单叫 `theme.toml`），而是作者遗留的完整**站点**配置，其 `theme = "noisedh-nav"` 指向一个不存在的名字；Hugo 会合并主题自带 config，故 `hugo --theme noisedh-nav-v1` 直接失败（`module "noisedh-nav" not found`）。把该文件改名/删除后 v1 可正常构建（17 页、约 208ms、首页 550KB 渲染正常）。但 v1 是深色外观，且功能上：搜索被 `{{ if $.Site.Params.header.enableSearch }}`（v1 partial :44）关掉、DOM 里根本没有 `#search-input`（已实测），而 v1 的搜索本身是**服务端**的（`fetch(\`${serverUrl}/api/search?...\`)`，v1 `component_header.js:181`）——即 v1 搜索必须依赖后端；`#date` 无收录数（v1 CONFIG 无 `statisticsMode`）；"最近收录"面板被 `enableRecentSites` 关掉；`bookmarks.html` 因 v1 无对应模板而回退成首页副本（550088 vs 550134 字节）。

**切换主题的三种方式**：改 `config.toml:4` 的 `theme` 键；`hugo server --theme <name>` 临时覆盖；Cloudflare Pages 用环境变量 `HUGO_THEME` 按部署切换。

## 6. 待确认 / 未完成

| 序号 | 事项 | 谁提供 | 用在哪 |
|------|------|--------|--------|
| 1 | `runGitSync` 只做 `add -A`→`commit`→`push`，全文无 `pull`/`rebase`/`fetch`/重试。远端一旦有服务器没有的提交（失效检测 Actions 或别处手改），push 被永久拒绝且无自愈，收藏在服务器静默积压而网站不更新 | 用户决定是否让我改（约十几行） | 后端落地前必修 |
| 2 | 后端地址可配置：在 Pages 域名下挂一个极小 Worker 做同源反代，前端只写相对路径 `/api/notifications`，真实地址存 Worker 环境变量，改完即时生效零重建；顺带免掉 CORS 和 mixed content | 用户需提供域名 | 满足约束 6 |
| 3 | `recentSitesApi`/`serverUrl` 现为占位符 `https://你的后端地址`（非空），前端会真去 fetch 它。**不能置空**——`component_header.js:196`/`:626` 的逻辑是"值为空则用 `https://extension.noisework.cn/api/notifications`"，置空等于把请求发给原作者服务器 | 用户填真实地址 | 配置清理 |
| 4 | `/search-index.json` 返回 404：`[outputs] home` 未注册 searchindex 输出格式，`index.searchindex.json` 从不渲染，但 CONFIG 仍注入该死链；目前搜索只靠 `searchIndexScriptUrl` 一条路活着，无回退 | 用户批准 | 搜索健壮性 |
| 5 | `baseURL` 硬编码 `https://www.noisedh.cn`，预览环境与自定义域都会指回旧域 | 用户批准 | 上 Pages 前必修 |
| 6 | Service Worker 缓存静态资源且无部署期失效策略，手机上会长期是旧快照 | 用户批准 | 上 Pages 前必修 |
| 7 | `.gitignore` 为空而 `publishDir="docs"`，构建产物未被忽略；后端 `git add -A` 会把它一并提交推送 | 用户批准 | 两项都要 |
| 8 | 搜索框可发现性：🔍 是透明背景胶囊、与输入框右端无缝拼接，窄视口下面板 top 落在 y=929（视口 776）在折叠线下。用户曾据此报告"前台没有搜索按钮"——功能其实正常，缺的是视觉提示 | 用户批准 | 可选改进 |
| 9 | Pages 构建设置（build command `hugo`、output `docs`）与失效检测改用 GitHub Actions 定时任务（`README.md` 已描述该工作流，需取消 cron 前的 `#`） | 用户批准 | 部署执行 |
| 10 | 用户是否仍想要 v1 的深色外观：整体换主题（需移植 v2 的静态搜索索引与 header partial）还是只要配色 | 用户回答 | 决定是否动主题 |

## 7. 下一场会话建议

先读本文档第 5、6 节。建议开口：确认从待办 1（`git pull --rebase`）开始，还是先做 5/6/7 这批上云前的配置清理。

不要做的第一步：不要装后端依赖或启动 `server.js`（见第 8 节）。也不要重新论证 Cloudflare/Railway 跑后端——已实测排除，理由在第 5 节。

## 8. 禁止事项

1. 不把 `yaml-server` 部署到 Cloudflare（容器磁盘 ephemeral，会丢数据）。
2. 不启用扩展的 GitHub 写入模式（会把 `data/webstack.yml` 的中文逐次写坏）。
3. 不把 `recentSitesApi` 留空或删除（会回落到原作者服务器 `extension.noisework.cn`）。
4. 未获用户明确要求，不执行 `npm install` / `node server.js`——`server.js` 是第三方代码，可读写 `BASE_DIR` 下文件并执行 `git` 命令，且 `cors({origin:'*'})` 配公网写接口风险面大；此前所有后端结论均为静态阅读所得，从未运行。
5. 不提交 `docs/` 构建产物。
6. 不把 Workers + KV/D1 重写当作顺手任务：9489 行、76 路由、110+ 处 `fs`，已评估为不成比例。

## 9. 用户要记住的原话

无。

## 10. 2026-09-26 晚更新：前台已上线

**已完成并验证**：前台部署到 Cloudflare Pages，正式地址 **https://nav.wzyo.top/**（TLS 正常，`search-index.json` 200，canonical/og 已指向新域）。

- 原第 6 节待办 **3/4/5/7 已完成**（commit `03b7b2c`）：`baseURL`/`og_url` → `https://nav.wzyo.top/`；`searchindex` 输出格式已注册（`baseName="search-index"`，389 条）；`recentSitesApi="/api/notifications"`、`serverUrl="/api"`（同源相对路径，非空，不会回落原作者服务器）；新增 `.gitignore` 忽略 `docs/`。
- **意外发现**：账号里早已存在 Git 集成的 Pages 项目 **`nav`**（子域 `nav-e9y.pages.dev`，production branch `main`，GitHub 已连 `sjmw/noisedh-nav`——push 即自动构建发布，实测 `03b7b2c` 推送后 1 分钟内构建成功）。列表 API 不返回 `source_control` 字段，别被误导。
- 待办 2 **完成一半**：前端相对路径已就位，还差在 Pages 域下挂 Worker 反代 `/api/*` → 用户服务器（真实后端地址存 Worker 环境变量，改地址零重建）。
- 待办 6（SW 缓存失效）：v2 `service-worker.js` 已是"版本号 cacheName + 清理旧缓存"，但版本号仍靠手工改，上线后未动。
- 待办 9 的构建设置无需再做（项目已存在且构建正常）；失效检测 Actions 未动。
- 待办 1（后端 `runGitSync` 加 pull --rebase）、8、10 状态不变。
- 本机推送走 SSH：`git@github.com:sjmw/noisedh-nav.git` + `~/.ssh/github_key`（HTTPS 无凭证）；本机经代理访问 GitHub 其实很快，"本地 GitHub 超时"旧结论仅适用于直连。
- wrangler 登录令牌的 OAuth scope **不含 DNS 读写**：Pages 域名绑定可由 API 建，但 CNAME 记录需用户在 dashboard 手加（本次 `nav → nav-e9y.pages.dev` 橙色云朵即手动添加）。

## 11. 2026-09-27 更新：noisedh-admin 上线，yaml-server 退役

**方案已演进（本节覆盖第 5 节"部署方案"与第 6 节待办 1/2）**：后台不再走"自己服务器跑 yaml-server"，而是全新子项目 **noisedh-admin**——Cloudflare Worker + D1（`admin/` 目录，独立于 Hugo 前台），书签导入→D1 查重→抓取/AI 分析→生成 `data/webstack.yml`→GitHub Contents API 推 main（触发 Pages 自动重建）。扩展 Nav-manage-extension 经附录 A 兼容层直连 Worker，手机收藏链路不变。

**生产已验证**：
- 发布链路两次真实 commit（含首跑 7 行预期引号 churn）+ 字节级 round-trip + 幂等短接（远端等于本次内容时零 PUT）。
- 远程 D1 与 GitHub yml 完全一致：0 pending / 381 published = yml 381 条 title（零漂移不变式成立）。
- 踩过的坑：GitHub 强制 User-Agent 策略——缺 UA 头带合法 PAT 也 403（curl 自带 UA 被豁免，Worker fetch 不带），已在 `github.ts` 修复。
- 手机冒烟 4 问题的修复轮已闭环：分类形态归一（flat 强制空 term / 嵌套空 term 补"未分组"，永不拒绝收藏）、孤儿分类清理（term='' 头行豁免，保 icon/排序）、AI 强制出分类（带现有子分类清单）、后台表单分类/子分类联动选择器。157/157 测试 + tsc 干净。
- 运维手册在 `admin/README.md`（部署、secrets、wrangler 命令）。

**yaml-server 状态：退役**。旧后端目录 `extension/yaml-server/` 仅存档，不再部署、不再运行；第 8 节禁止事项 1/2/4 因对象退役而自然封版（2 对扩展 GitHub 写入模式的警告永久有效）。

**剩余事项**：
1. 手机复冒烟 4 场景（归一/未分组/重分析/datalist）。
2. `git push origin main`（本地 main 已 ff 合并到 `6f7863d`，会话 shell 无 GitHub 凭证，需用户终端执行）。
3. 后台界面美化——用户裁决单独一轮，未开始。
4. SDD 工作区销账：`.superpowers/sdd/2026-09-26-cloudflare-admin/`（ledger 是权威进度记录）。
