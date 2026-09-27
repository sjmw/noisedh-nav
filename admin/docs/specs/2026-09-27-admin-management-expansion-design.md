# 后台管理扩展设计（友链 / 顶部导航 / 分类管理 / 批量删除 / 自动 icon）

**日期**：2026-09-27　**状态**：待用户终审
**基线**：`2026-09-26-cloudflare-admin-design.md`（下称 spec-26）之上的增量；冲突处以本文为准
**分支落点**：`feat/admin-ui-polish`（美化轮 `d8464cc`+`61c82e7` → 修复轮 `56f3b7d` → logo 链 `d7e39fb` → 本轮）

## 0. 目标与非目标

用户四点需求 → 四组能力：

1. 友情链接、顶部导航纳入后台管理（现在只能管网址列表）。
2. 删除族：单删 / 勾选批删 / 按筛选全删 / 清空全库；多行删除必须弹窗确认；覆盖站点、分类、友链、导航。
3. 分类 / 子分类 CRUD + 批量删除；改名级联同步站点行；分类（子分类）下仍有网址时禁删。
4. 新建分类（子分类）时自动配「最适配」icon（Font Awesome 类名）。

**非目标（YAGNI）**：分类隐式合并（改名撞已有名直接拒，不做自动合并）；多级导航（顶层+一层下拉封死）；图标上传/图床；发布外的 git 直改；友链/导航的骤降闸；书签导入对新表的处理。

## 1. 裁决记录（会话内已定，实施时不得重开）

| # | 决定 | 理由 / 代价 |
|---|------|-------------|
| R1 | 友链与顶部导航以 **D1 为真源**，发布时与 webstack.yml 一并重建写回 GitHub | 统一「后台编辑→D1→发布快照」模型。**覆盖 spec-26 §5「friendlinks.yml 永不触碰」**：改为 webstack / friendlinks / headers 三文件由后台单写，其余文件仍不碰 |
| R2 | 「全部删除」两种形态都要：按当前筛选全删 + 显式「清空全库」危险操作 | 清空全库弹窗需输入「全部删除」解锁；发布侧仍有 0 行/骤降闸兜底 |
| R3 | icon 判定 = **AI 优先 + 关键词规则表兜底 + 默认图标** | 未配 AI 的环境（本地 dev）规则表照常工作，离线可测 |
| R4 | **prune 退场（推翻既有裁决）**：`pruneOrphanCategories` 的全部调用点移除，categories 行从此只增不自动删 | 与「手动先建空分类再收站点」的一等公民语义直接冲突（自动清理会误杀新空行）。代价：删站/重分析后可能留下空分类（builder 对空组本就容忍，导出无害），由分类管理页可见、可删。原「term='' header 行豁免」裁决随 prune 一起失效；写入口的形态归一（`resolveCategoryShape`）**不变**，防垃圾仍靠写入口 |

## 2. 数据模型（schema.sql 增量）

```sql
CREATE TABLE IF NOT EXISTS friendlinks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,                    -- 原样存（不 normalizeUrl：人工维护的字节保真数据）
  description TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS navitems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item TEXT NOT NULL,                   -- 顶层=item 名；子项=name（builder 按 parent 映射键名）
  icon TEXT NOT NULL DEFAULT '',        -- 仅顶层有；子项忽略
  link TEXT NOT NULL DEFAULT '',        -- 顶层=link；子项=url；'' =纯下拉容器（如「更多」）
  parent_id INTEGER,                    -- NULL=顶层；非 NULL=下拉子项（限一层：父必须是顶层行）
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- 两表与 categories 一样**无 pending/published 状态**：改动即时入库，前台生效统一等下一次「批量发布」。
- `IF NOT EXISTS` 保证对已建库环境重放不报错（既有约定）；无 ALTER。

## 3. 后端 API（全部挂 requireAuth；错误沿用冻结 7 码，守卫拒绝=bad_request，缺行=404 信封）

### 3.1 `/api/admin/friendlinks`

- `GET` → `{friendlinks:[按 sort,id 排序]}`
- `POST` `{title,url,description?,sort?}` → 201 `{friendlink}`；仅校验 title/url 非空、类型对
- `PATCH /:id` 白名单 `{title,url,description,sort}` → `{friendlink}`；缺行 404
- `DELETE /:id` → 204（幂等）
- `POST /batch-delete` `{ids:number[]}` → `{deleted:n}`；ids 非正整数数组 → 400

### 3.2 `/api/admin/navitems`

- `GET` → `{navitems:[平铺行，顶层按 sort,id，子项紧跟其父]}`
- `POST` `{item,icon?,link?,parent_id?,sort?}`；`parent_id` 非空 → 父必须存在且自身 `parent_id IS NULL`，否则 400；子项不存 icon（置 ''）
- `PATCH /:id` 白名单 `{item,icon,link,parent_id,sort}`；换父同样过一层限制；不能挂到自己下
- `DELETE /:id`：有子项 → 400（message 提示先删子项）；否则 204 幂等
- `POST /batch-delete` `{ids}`：**原子**——若集合中某行的子项不在集合内 → 400 整体拒；否则整批删

### 3.3 `/api/admin/categories`（现有端点演进）

- `GET`：现有 `{categories, shapes}` 基础上，`categories` 每行附 `siteCount`（该 (taxonomy,term) 下 sites 行数，**任意 status**，与形态权威口径一致）；`shapes` 原样不动
- `POST`：保留现有形态拒绝逻辑；变更两处——① `icon` 缺省时走 §5 决策链自动配（现在落死默认值）；② 响应 204 → 201 `{category}`（UI 要取回自动 icon；唯一消费方是自家后台，兼容风险为零）
- `PATCH`（新增）`{taxonomy, term, new?:{taxonomy?,term?,icon?,sort?}}` 定位源行；四个子场景：
  - **只改 icon/sort**：仅动 categories 行。
  - **改 taxonomy**：目标名在 categories∪sites（任意 status）已存在 → 400（提示先手动搬站点，不做隐式合并）；否则 `UPDATE categories SET taxonomy=new WHERE taxonomy=old`（含 header 与全部子行）+ 同条件 `UPDATE sites`，两语句连发（D1 无跨语句事务需求：撞名闸已前置）。
  - **改 term**（taxonomy 不变）：目标 (taxonomy,newTerm) 任一源已有行 → 400；否则 categories+sites 联动改名。
  - 源行不存在 → 404。
- `DELETE ?taxonomy=&term=`：在现有 deleteCategory 前加守卫——该 pair `siteCount>0` → 400（message 带条数）；`term=''`（删整个分类）要求该 taxonomy **全部 term** 零站点，且连带删除其所有子分类行；单 term 删除只要求本 pair 为空。
- `POST /batch-delete`（新增）`{pairs:[{taxonomy,term}]}`：原子。任一 pair 非空 → 400，message 列出全部受阻 pair 与条数；否则整批删（header 行同删规则同上）。

### 3.4 `/api/admin/sites/batch-delete`（新增）

- 体三形态互斥：
  - `{ids:[…]}` → 勾选批删；
  - `{filter:{q?,status?,taxonomy?,term?}}` → 按筛选全删（与 `GET sites` 同 where 语义，含 LIKE 转义）；
  - `{wipe:'全部删除'}` → 清空全库（服务端等值校验该字符串，防无 body 误触）。
- 响应 `{deleted:n}`；删完**不再** prune（R4）。
- 现有单行 `DELETE /:id` 保留（去掉其 prune 调用）。

## 4. 发布链路（三文件）

`doPublish` 流程改为：

1. 读 D1：sites/categories（现有）+ friendlinks 全表 + navitems 全表。
2. 构建三份内容：
   - `data/webstack.yml`：`buildWebstackYml` 不动；
   - `data/friendlinks.yml`：新 `buildFriendlinksYml(rows)`——`- title / url / description`（有则出），按 sort,id；空表出 `[]`；
   - `data/headers.yml`：新 `buildNavYml(rows)`——顶层 `- item / icon / link`（link='' 显式输出，对齐现状「更多」），子项紧跟父的 `list:` `- name / url`；空表出 `[]`。
3. 闸口不变：0 行闸与骤降闸仅针对 webstack 快照。
4. **预检后写**：三文件并行 `ghGet`（sha+内容）；逐文件比对，远端已等于本次内容 → 该文件跳过（幂等短接）。全部无冲突才开 PUT 序列（至多三个 commit）。
5. 冲突语义：PUT 阶段 409 → 仅重 GET 对账该文件；远端≠本次内容 → `github_conflict` 中止。此时**已 PUT 的前序文件不回滚**——返回 message 点明「N 个文件已更新，M 个未更新，重试点发布可收敛」（内容比对幂等，重试自愈）。
6. 全部 PUT 成功（或跳过）→ 才 `markPendingPublished`（发布即快照语义只对 webstack，friendlinks/navitems 无状态翻转）。
7. 响应：`{commitUrl, count, friendlinks:n, navitems:n, files:[{path, action:'put'|'skip'}]}`；`commitUrl`=本次最后一个新 commit（无新 commit 时沿用现有幂等路径行为）。

## 5. icon 决策链（R3）

新模块 `src/icons.ts`：

- `iconFor(name: string): string`——纯函数规则表（中英关键词 contains，≈40 条）：设计/美工→`fa-palette`、视频/影视/剧集→`fa-film`、音乐/歌曲→`fa-music`、游戏→`fa-gamepad`、阅读/书/小说→`fa-book-open`、新闻/资讯/热榜→`fa-newspaper`、工具/效率→`fa-wrench`、AI/智能→`fa-robot`、图片/摄影/图库→`fa-image`、云盘/资源/软件→`fa-cloud`、导航/聚合/综合→`fa-compass`、购物/电商→`fa-shopping-cart`、开发/代码/编程→`fa-code`、邮箱/邮件→`fa-envelope`、动漫/二次元→`fa-masks-theater`、直播/视频直播→`fa-video`、字幕/配音→`fa-closed-captioning`、封面/图文→`fa-image-portrait`、无人机/航拍→`fa-helicopter`、模版/插件→`fa-puzzle-piece`、虚拟主播→`fa-vr-cardboard`、学习/教育/词典→`fa-graduation-cap`、搜索→`fa-magnifying-glass`、社交/社区→`fa-comments`、地图/出行→`fa-map`、财经/支付→`fa-coins`、播客/电台→`fa-podcast`、博客/日志→`fa-feather`、备用/镜像→`fa-clone`、热/热门→`fa-fire` 等；未命中→现默认 `fas fa-folder-open fa-lg`。前缀统一 `fas`（主题 FA 版本兼容 fas/far/fab）。
- `resolveIcon(name, env, fetchImpl?): Promise<string>`——AI 配置齐（`AI_BASE_URL/AI_API_KEY/AI_MODEL`）时发一次单题小调用（system 给定输出格式：只回一个 FA 类名；5s 超时；类名格式不合法/网络失败 → 落 `iconFor`）；未配置直接 `iconFor`。

**三个集成点：**

1. **流水线补行**（`analyzeAndUpsert` 里 categories 缺行时）：非直通且 AI 分析已发生 → 优先用 aiAnalyze 新增的可选 `icon` 字段（见 2），否则 `iconFor(taxonomy+term)`；**直通路径零网络不变** → 只 `iconFor`。
2. **aiAnalyze 提示词**：`new_category=true` 时可附 `icon`；校验独立于全有或全无闸——icon 不合规只弃 icon 字段，不废整条结果。
3. **管理端 POST categories**：`icon` 缺省 → `resolveIcon`（允许一次网络，与流水线闸不同）。

## 6. seed 与闸口

- `scripts/seed.mjs`：从 `data/` 三文件生成 seed.sql；friendlinks/navitems **显式写 id**（navitems 子项 parent_id 指向显式父 id），顺序即文件序（sort=下标）。seed.sql 开头 DELETE 扩为五表。
- 闸口测试：webstack 逐字节 round-trip 断言**不动**；新增 friendlinks/headers **语义 round-trip**（`js-yaml` 解析 builder(seed 行) 与源文件 deep-equal，含数组序）。接受首次发布对这两文件产生一次性格式 churn（行尾空格等归一），README 发布步骤注明。
- 381/389 权威行数闸不动。

## 7. 管理 UI

- tabs 扩为：列表 / 分类 / 友链 / 导航 / 导入 / 新增。
- **`confirmModal({title, lines[], danger?, requireText?}): Promise<boolean>`** 自制弹窗（零 innerHTML 纪律；外点/Esc 关；`requireText` 未逐字输入前确认钮禁用）。单行删除保留现有轻量 `confirm()`，一切**多行删除**走 confirmModal 且 lines 里给出条数与分布摘要。
- **列表页**：首列 checkbox+表头全选（当前页）；工具栏新增「删除选中 (n)」「删除当前筛选全部 (total)」；独立红底「清空全库」（requireText=「全部删除」）；筛选命中数随 loadList 的 total 顺手可得。
- **分类页**：表=categories 行（顶层与其子行按 sort 分组、显示 siteCount）；行内：改名/改 icon（输入框+▾ 组合框候选=既有 icon 集）/改 sort；顶部新建表单（分类/子分类联动选择器复用 combobox，icon 自动并预填可改）；勾选批删（弹窗列出被非空阻挡的行）。
- **友链/导航页**：简单表+新增表单+行内编辑+单删+勾选批删；导航行子项缩进显示，「父项」下拉只列顶层行。
- 移动端 ≤760px 卡片布局沿用（checkbox 进卡片头行；弹窗宽度自适应）。

## 8. 测试策略

- 单测：`icons.ts` 规则表 + 默认兜底 + AI 返回校验（只弃 icon 不弃整体）；`buildFriendlinksYml/buildNavYml` 形状、空表、相对链接、`link:''`、下拉子项分组序。
- 路由集成（unstable_dev + fake/本地 D1）：三套 CRUD 全走；navitems 一层限制与批删原子；categories 改名级联（sites+categories 双查断言）、撞名拒、非空禁删、批量原子拒；`siteCount` 正确性；batch-delete 三形态；prune 退场断言（删站后空分类行**仍在**）。
- 发布：三文件预检/全 skip/单文件 put/409 冲突中止（点明部分成功）/重试收敛；pending 翻转仅在全部成功后。
- seed：语义 round-trip 两份新文件。
- UI：browser-use 双视口实测（批删弹窗、requireText 解锁、分类改名联动回列表、新建自动 icon 预填）+截图自查；`npm test`+`tsc --noEmit` 全绿闸。

## 9. 运维注记

远程副作用一律用户放行：本地 `--local` 灌 schema/seed 归实现自便；**远端** D1 需 `wrangler d1 execute navdata --remote --file=./schema.sql`（可重放）+ seed 全量替换（README 全量替换警告沿用）；deploy/publish 归用户。首次带新代码发布前，远端表必须先建（否则 doPublish 读表 500）。
