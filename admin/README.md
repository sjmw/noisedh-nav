# noisedh-admin 部署手册（Task 12 runbook）

Cloudflare Worker + D1 后台（导入/编辑/发布 + 扩展兼容层）。以下命令全部在 `admin/` 目录执行；
`wrangler` 已作为 devDependency 安装，`npx wrangler …` 与 `./node_modules/wrangler/bin/wrangler.js …` 等价。
本地门禁：`npm test`（126 用例）+ `npm run typecheck`；`npm run dev` 起本地冒烟（见下「本地冒烟」）。

## 前置安装（一次性）

```bash
npx wrangler login          # 浏览器授权到 wzyo 的 Cloudflare 账号
```

## 步骤 1 · GitHub PAT（用户口令动作）

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token：

- 仓库范围：**Only select repositories → `sjmw/noisedh-nav`**（单仓，最小权限，安全红线：绝不选 All repositories）
- Permissions → Contents：**Read and write**（仅此一项；Administration/Metadata 无需手动勾，fine-grained 会自动带 Metadata）
- **设置过期时间**（如 90/180 天）并同时在日历里设好续期提醒：fine-grained 单仓 + 仅 Contents 写权限，泄露面已最小，带过期的 PAT 是更稳妥的常态；到期按提醒重新生成。生成后妥善保存（只显示一次）

## 步骤 2 · 创建 D1 并回填 database_id

```bash
npx wrangler d1 create navdata
```

把输出中的 `database_id` 回填进 `wrangler.jsonc` 的 `d1_databases[0].database_id` 字段。
**未回填前所有 `--remote` D1 命令都会报错**，这是刻意的防呆（防止误连别库）。

## 步骤 3 · 远程建表 + secrets

```bash
# 建表（schema.sql 幂等：全部 CREATE TABLE IF NOT EXISTS）
npx wrangler d1 execute navdata --remote --file=./schema.sql --yes
```

`--file=./xxx.sql` 为 wrangler 4.141 已验证的命令形态（同命令去掉 --remote 加 `--local` 可在本机跑通，
本项目测试链路即用它初始化本地 D1）。`--yes` 跳过远程写入的交互确认，非交互 shell 下必带。

```bash
npx wrangler secret put ADMIN_TOKEN      # 长随机串，管理页与扩展共用的 Bearer
npx wrangler secret put GITHUB_TOKEN     # 步骤 1 的 fine-grained PAT
# 可选（spec §2.1：三项中任一缺失 → AI 分析整体走降级解析，不报错）：
npx wrangler secret put AI_BASE_URL
npx wrangler secret put AI_API_KEY
npx wrangler secret put AI_MODEL
```

**secret 还是 var 的裁定**：只有会泄露的东西走 secret（上面这些）。`DEFAULT_TAXONOMY`（默认 `未分类`）与
`FAVICON_TEMPLATE`（默认 `https://icons.duckduckgo.com/ip3/{host}.ico`）非密，已作为 `vars` 写在
`wrangler.jsonc` 里随仓库走，改值 = 改文件重新 deploy，不用 secret put。

## 步骤 4 · 部署 Worker

```bash
npx wrangler deploy
npx wrangler deployments list    # 确认版本与 assets 上传成功
```

## 步骤 5 · 区域路由（zone `wzyo.top`，三条规则 → Worker `noisedh-admin`）

dashboard：Workers & Pages → noisedh-admin → Settings → Routes，添加三条（或用 API：`POST /zones/{wzyo.top zone id}/filters`）：

| # | 路径 | 服务 |
|---|---|---|
| 1 | `nav.wzyo.top/admin*` | noisedh-admin |
| 2 | `nav.wzyo.top/api/*` | noisedh-admin |
| 3 | `nav.wzyo.top/data*` | noisedh-admin |

> 规则 1 刻意写 `admin*`（非 `admin/*`）：一并接管 `/admin.js`，`/admin` 页面的脚本走同一 Worker 资产直出。

> **硬性约束（brief 原话）**：若 `/api/*` 路由在 Pages 自定义域上不生效（被 Pages 站点拦截），
> **立即停下报告，不要私改前台**——不得动 Pages 项目、不得往 Pages 塞 `_worker.js`。

## 步骤 6 · 远程灌种子数据

```bash
npx wrangler d1 execute navdata --remote --file=./seed.sql --yes
```

`seed.sql` 由 `npm run seed` 从 `data/webstack.yml` 生成（round-trip 零漂移闸口由测试保证）。

> ⚠️ **全量替换警告**：`seed.sql` 开头是 `DELETE FROM sites; DELETE FROM categories;`，而 `--yes` 会跳过
> wrangler 的交互确认——执行 `--remote` 这条命令会**替换线上全部行**，冒烟期间收集到的 pending/编辑中
> 条目会一并丢失。跑之前先备份：
> `npx wrangler d1 execute navdata --remote --command "SELECT * FROM sites" --json > backup.json`

## 步骤 7 · publish 干跑

> ⚠️ **顺序警告**：**绝不可在未灌种子（步骤 6）或 D1 被清空的库上调用** `POST /api/admin/publish`——
> doPublish 没有最小行数保护，会把近乎空的 `data/webstack.yml` 推到线上仓库。步骤 6（seed）必须先于步骤 7（publish）。

```bash
curl -sS -X POST https://nav.wzyo.top/api/admin/publish -H "Authorization: Bearer <ADMIN_TOKEN>"
```

预期：`{"commitUrl":…,"count":389}`。**首次干跑可能产生一个 7 行引号风格 churn 的 commit（语义 diff 为零）**
——seed 与线上 `webstack.yml` 的 YAML 引法可能有出入，属预期内一次性噪音；干跑后再点一次应走
「远端内容 = 本次将写」幂等短路（不再产生 commit）。若报 `github_conflict` 说明远端有非本次发布的改动，停下人工看 diff。

## 步骤 8 · 手机扩展冒烟清单（用户参与）

1. 电脑浏览器开 `https://nav.wzyo.top/admin` → 输入 ADMIN_TOKEN → 「进入」→ 列表出现 389 行
2. 手机 Chrome 装 `extension/Nav-manage-extension` → 选项里 serverUrl 改 `https://nav.wzyo.top`、token 填 ADMIN_TOKEN
3. 任意网页点扩展「收藏」→ 回 `/admin` 列表筛选「待发布」→ 出现 pending 行 → 编辑标题 → 「批量发布」
4. GitHub 仓库出现发布 commit → Pages 自动构建 → 前台刷新可见新条目

## 回滚

| 层 | 操作 |
|---|---|
| 内容（GitHub） | 在 `sjmw/noisedh-nav` revert 对应发布 commit，Pages 随重构建 |
| 数据（D1） | `npx wrangler d1 execute navdata --remote --file=./seed.sql --yes` 重灌基线 |
| Worker | `npx wrangler deployments list` 找上一次 Worker Version ID → `npx wrangler rollback <deployment-id>`（wrangler 4.141 该顶层命令即版本回滚，位置参数为 Worker Version ID，无 `versions rollback` 子命令） |

## 本地冒烟（不碰远程的等价验证）

```bash
npm run dev      # wrangler dev（本地 D1 需先 --local 建表灌种：把上面两条命令的 --remote 换成 --local）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8799/         # 200（UI，资产直出）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8799/admin    # 200（UI，Worker 改写）
curl -s http://127.0.0.1:8799/nope                                      # 404 {"error":"bad_request",…}
```

`/admin` 机制：`public/admin/index.html` 重复副本已删除；`/admin`、`/admin/` 无资产命中自然落入 Worker，
Worker 经 `env.ASSETS` 绑定改写抓取 `/index.html` 原文返回（非重定向）。页面脚本/API 全按源根绝对路径
（`/admin.js`、`/api/…`）引用，挂在 `/` 或 `/admin` 下同源同形。

## 附：搜索是否只搜已发布（一行开关）

当前 `/api/search` 含 pending（扩展是管理工具，手机收藏后需可见可删）。若日后想改成只搜已发布，
改 `src/extension.ts:137`：`listSites(db, { q: keyword, perPage: 200 })` → 加 `status: 'published'` 即可。
