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
