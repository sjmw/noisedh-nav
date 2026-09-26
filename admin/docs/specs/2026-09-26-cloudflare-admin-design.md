# noisedh-admin：Cloudflare 导航站后台设计（spec）

> 日期：2026-09-26 ｜ 状态：已获用户批准的设计
> 前置阅读：仓库根目录《noisedh-nav会话交接.md》第 5、6、8、10 节

## 1. 目标与决策记录

为导航站提供一个可直接部署到 Cloudflare 的轻量后台，替代用户服务器上的 yaml-server，成为收藏数据的唯一写入链路。

功能需求（用户原述）：
1. 导入 Chrome 导出的书签 HTML，存入 D1，重复去重
2. 配置了 AI 则对 URL 分析提取标题/描述/分类/子分类；未配置则抓取网页内容分析
3. 解析结果更新到 D1
4. 查询接口读 D1；发布时按导航站格式生成 `data/webstack.yml` 并推送 GitHub（触发 Pages 重建）
5. 提供"给一个 URL 即添加"的新增接口

已拍板决策：
- **完全替代 yaml-server**：单一写入源。yaml-server 不再部署运行；发布后手工改 GitHub 上的 `webstack.yml` 视为非法（会被下次发布覆盖）
- **D1 为唯一权威数据源**：初始从现有 `webstack.yml` 灌入 389 条
- **AI 走通用 OpenAI 兼容接口**（环境变量配置，不内置特定厂商）
- **入口挂 `nav.wzyo.top`**：区域路由把 `/admin*`、`/api/*` 指给 Worker，其余仍到 Pages；这同时完成交接待办 2（Worker 反代），前台零重建
- **兼容 Nav-manage-extension 一键收藏**（接口形状按 popup.js 实测逆推）

明确不做（YAGNI / 交接禁止事项）：失效检测、RSS 订阅、音乐 API、统计服务等 yaml-server 外围功能；多用户权限；`friendlinks.yml` 纳入权威流（保持独立，后台不碰）；在 Cloudflare 跑任何需要磁盘的进程。

## 2. 总体架构

```
浏览器 ── nav.wzyo.top/admin ──► Worker(noisedh-admin, Assets 内置管理页)
前台页面 ─ nav.wzyo.top/api/* ──► Worker ── D1(navdata) ── sites/categories
                                   │
                                   ├─► AI chat completions（可选，OpenAI 兼容）
                                   ├─► 目标站点 fetch（正文提取/降级解析）
                                   └─► publish：重建 yml → GitHub Contents API
                                            └─► push main → Cloudflare Pages 自动重建
```

单 Worker 项目 + 单 D1。管理 UI 为 Workers Static Assets 上的无构建工具单页（原生 HTML/JS，无框架）。

### 2.1 配置（env / secrets）

| 变量 | 形式 | 说明 |
|---|---|---|
| `ADMIN_TOKEN` | secret | 管理页与扩展共用的 Bearer |
| `GITHUB_TOKEN` | secret | fine-grained PAT，仅 `sjmw/noisedh-nav` 单仓 Contents: Read&Write |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | secret/env | 可选；任一缺失即整体走降级解析 |
| `DEFAULT_TAXONOMY` | env | 降级/无法归类时的分类，默认 `未分类` |
| `FAVICON_TEMPLATE` | env | logo 生成模板，默认 `https://icons.duckduckgo.com/ip3/{host}.ico` |
| `REPO` | env | `sjmw/noisedh-nav`（含 owner） |

### 2.2 部署工件

`admin/` 目录内：`wrangler.jsonc`（d1 binding + assets + routes 注释示例）、`schema.sql`、`src/`、`public/`（管理页）、`scripts/seed.ts`（yml→SQL 引导脚本）、测试目录。区域路由（`nav.wzyo.top/admin*`、`nav.wzyo.top/api/*`）部署时创建。

## 3. 数据模型（D1 `navdata`）

```sql
CREATE TABLE sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,            -- 规范化后
  url_raw TEXT NOT NULL,               -- 原样，用于展示与导出
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  logo TEXT NOT NULL DEFAULT '',       -- 文件名或绝对 URL，原样透传
  taxonomy TEXT NOT NULL,              -- 分类
  term TEXT NOT NULL DEFAULT '',       -- 子分类，''=直挂分类
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | published
  source TEXT NOT NULL DEFAULT 'manual',   -- import|manual|extension|seed
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sites_status ON sites(status, taxonomy, term, sort);

CREATE TABLE categories (
  taxonomy TEXT NOT NULL,
  term TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT 'fas fa-folder-open fa-lg',
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (taxonomy, term)
);
```

### 3.1 URL 规范化（去重键）

`trim` → 协议缺失补 `https://` → host 小写 → 去末尾 `/` → 删除查询参数中的 `utm_*`、`gclid`、`spm`、`from`、`ref`（白名单式保守删除）→ 保留其余参数与 hash。`UNIQUE(url)` 冲突即判重；导入响应必须报告"新增 N、重复跳过 M、解析失败 K"三类计数。

### 3.2 引导迁移

`scripts/seed.ts`：解析仓库 `data/webstack.yml`（含两种形态：`links` 直挂 与 `list[{term,links}]` 嵌套）→ 生成 `seed.sql` → `wrangler d1 execute --remote`。同时把出现的 taxonomy/term 灌入 `categories`。种子数据 `source='seed'`、`status='published'`、`sort` 保持原文件顺序。

**验收不变式**：seed 导入 D1 后原样导出 yml，与 `data/webstack.yml` 做语义 diff（解析后深比较，允许键序不一致）必须为零。此条为 §5 序列化器的核心测试。

## 4. 解析流水线（导入、新增、重分析共用同一实现）

输入 `{url, hint_title?, hint_desc?}`，输出写入 `sites`（`status='pending'`）：

1. `fetch(url)`，UA 伪装浏览器，8s 超时；取 HTML 前 ~64KB，正文文本截 ~4KB
2. **基线字段**（AI 与降级共用）：`<title>`（按 `|`/`-`/`–` 裁站点后缀）、`meta description` / `og:description`、`og:site_name`
3. **AI 分析**（配置齐全时）：chat completions，`temperature=0`，提示词内嵌 D1 `categories` 现有分类清单 + 站点正文，要求输出严格 JSON `{"title","description","taxonomy","term","new_category"?:bool}`；`response_format=json_object`（不支持时以提示词约束+解析校验兜底）。description 目标 ≤40 字，中文优先。输出校验：JSON 可解析、字段齐全、taxonomy/term 若非已有分类则必须 `new_category=true` 且命名合法；任何不合规 → 整条走降级，不做半采信
4. **降级**（未配置 AI / AI 失败 / 页面不可达）：基线字段 + `taxonomy=DEFAULT_TAXONOMY`、`term=''`；页面完全不可达时标题退化为 host，`source` 记录入口，标记 pending 等人工编辑
5. `logo` 为空则按 `FAVICON_TEMPLATE` 生成 URL
6. 批量导入（书签）时逐条处理但整体事务入库，AI 调用限并发（默认 3）

发布前 pending→published 由人工在管理页单条/批量确认（防止脏数据直达线上）。

（2026-09-27 裁定：发布即快照——publish 时全部 pending 随快照上线，人工确认前移到发布按钮的 pending 清单弹窗）

### 4.1 Chrome 书签导入

Netscape Bookmark File Format：解析 `DL`/`DT`/`H3` 嵌套结构，文件夹路径即分类建议（首层 `H3` 是浏览器账户名，丢弃；`其他书签`/`bookmark bar` 记入 `hint`）。条目走同一流水线；`ADD_DATE` 保留为 `created_at` 参考。解析器手写（正则+状态机，约 100 行，无第三方依赖），输入上限 10MB。

## 5. 发布（生成 yml + 推 GitHub）

`POST /api/admin/publish`：

1. 读 D1 全部 `published` 行 + `categories`，按 `taxonomy(sort) → [list: term(sort) → links] → [links: sort]` 重建 `data/webstack.yml`；term 全为 `''` 的分类输出直挂 `links` 形态（两种形态与现有文件一致），`icon` 取 `categories.icon`
2. GitHub Contents API `GET /repos/{REPO}/contents/data/webstack.yml?ref=main` 取 `sha`
3. `PUT` 同路径：UTF-8 正文 `TextEncoder → base64`（修正扩展 latin1 编解码不对称的坑），commit message `后台发布：N 条站点（M 条新增）`
4. PUT 返回 409（sha 过期）→ 重新 GET→合并检测→若远端内容有非本次发布的改动则**中止并报错**（单一写入源假设被破坏时宁停不猜），否则重试一次
5. 成功返回 commit URL；Pages 自动构建上线

`friendlinks.yml` 永不触碰。pending 条目不进导出。

（2026-09-27 裁定：发布即快照——publish 时全部 pending 随快照上线，人工确认前移到发布按钮的 pending 清单弹窗）

## 6. HTTP 接口

鉴权：`Authorization: Bearer ${ADMIN_TOKEN}`，timing-safe 比较。未授权一律 401，不区分"无权限"与"不存在"。

| 方法/路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/admin/import` | `{html: "<书签文件内容>"}`（纯 JSON；管理页在浏览器端读文件后提交，不用 multipart） | `{added, skipped_dup, failed, items:[{url,status,reason}]}` |
| `POST /api/admin/sites` | `{url}` | 同分析结果（功能 5） |
| `GET /api/admin/sites` | `?status=&taxonomy=&q=&page=` | D1 分页列表（功能 4 的查询接口） |
| `PATCH /api/admin/sites/:id` | 任意字段子集（含 status） | 更新后行 |
| `DELETE /api/admin/sites/:id` | — | 204 |
| `POST /api/admin/sites/:id/analyze` | — | 重跑流水线 |
| `GET/POST/DELETE /api/admin/categories` | 分类表管理 | — |
| `POST /api/admin/publish` | — | §5 |
| `GET /api/notifications` | 公开（只读） | 最近 20 条 published，`[{title,description,url,timestamp}]`，形状对齐前端 `component_header.js` 消费逻辑 |

### 6.1 扩展兼容层

实施计划的第一步即逆推 `extension/Nav-manage-extension/popup.js` 云服务器模式：列出其真实请求（方法/路径/字段/鉴权头）清单，在 Worker 上实现同形状接口（内部映射到本 spec 的分析+入库流水线），并出验收清单——扩展内改服务器地址为 `https://nav.wzyo.top`，点收藏后 D1 出现 pending 行。若扩展调用面超出预期，列为补丁任务而非扩大初版范围。

## 7. 管理 UI（/admin）

单 HTML + 单 JS：口令输入（sessionStorage）→ 三视图——①导入（粘贴/选文件+结果计数）②列表（状态/分类筛选、行内编辑 title/taxonomy/term/logo/description、单条与批量"分析""发布"、发布按钮+结果 toast）③新增（一个 URL 输入框）。不追求样式，功能可键盘完成。前台站点因此设计**零改动**。

## 8. 错误处理与日志

统一 JSON 错误 `{error:code,message}`；code 枚举：`unauthorized/bad_request/dup_url/fetch_failed/ai_invalid/github_conflict/too_large`。Worker console + `wrangler tail` 为观测面，不引外部监控。所有外部调用（AI、目标站、GitHub）带超时与单次重试。

## 9. 测试策略

- **单测**（Vitest + miniflare 本地 D1）：URL 规范化边界；书签解析器（fixture：真实 Chrome 导出文件样本）；yml 序列化（389 条 round-trip diff 为零＝§3.2 不变式）；AI 响应校验（合法/非法/半吊子 fixture）
- **集成**（`wrangler dev`）：全链路 mock GitHub（msw/nock 式 stub）+ fixture AI：导入→分析→编辑→发布→断言 PUT payload 内容与 sha 流程；扩展兼容层按 §6.1 清单逐个断言
- **部署后手工冒烟**（用户参与）：真实书签导入 → 编辑一条 → publish → Pages 新构建 → nav.wzyo.top 出现新条目 → 手机扩展点收藏进 pending
- 类型：TypeScript strict，`wrangler check`/tsc 进 CI 前置（本仓库暂无 CI，暂以本地门禁）

## 10. 里程碑拆分（供实施计划细化）

1. 扩展接口逆推 → 接口清单确认（一次性调研，产出物进 spec 附录）
2. Worker 骨架：schema/迁移/env 校验/auth/错误壳 + 本地测试基建
3. 流水线：fetch+基线提取 → AI 分析 → 降级 → seed 脚本与不变式测试
4. publish：yml 生成 + GitHub 推送 + 冲突策略
5. 扩展兼容层 + notifications
6. 管理 UI
7. 部署（D1 创建、路由、secrets、seed 灌库）+ 冒烟

## 11. 安全约束

`GITHUB_TOKEN` 权限最小化到单仓库 Contents；`ADMIN_TOKEN` 为长随机串；管理页静态可访问但无数据；不新增任何匿名写接口；日志不落 token；D1 无跨站泄露面（notifications 只暴露本就公开展示的数据）。
