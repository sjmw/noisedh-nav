CREATE TABLE IF NOT EXISTS sites (
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

CREATE TABLE IF NOT EXISTS categories (
  taxonomy TEXT NOT NULL,
  term TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT 'fas fa-folder-open fa-lg',
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (taxonomy, term)
);

-- 管理扩展轮（spec-27 §2）：友链与顶部导航以 D1 为真源；url/link 原样存，无状态列（改动随下一次发布上线）
CREATE TABLE IF NOT EXISTS friendlinks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS navitems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  parent_id INTEGER,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_navitems_parent ON navitems(parent_id);

-- Task 10：扩展推送参数（POST /api/server-settings，扁平字符串键值原样存储、Worker 不解释）
-- 带 IF NOT EXISTS：对已建库的部署环境重放本文件不报错（终局评审 minor-2：sites/categories 同步补齐）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
