// 与 schema.sql sites 表列序、类型逐字段一致
export interface SiteRow {
  id: number;
  url: string;
  url_raw: string;
  title: string;
  description: string;
  logo: string;
  taxonomy: string;
  term: string;
  status: string;
  source: string;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface CategoryRow {
  taxonomy: string;
  term: string;
  icon: string;
  sort: number;
}

// 管理扩展轮（spec-27）：与 schema.sql friendlinks/navitems 表逐字段一致
export interface FriendlinkRow { id: number; title: string; url: string; description: string; sort: number; created_at: string; updated_at: string }
export interface NavitemRow { id: number; item: string; icon: string; link: string; parent_id: number | null; sort: number; created_at: string; updated_at: string }

export interface Env {
  ADMIN_TOKEN: string;
  GITHUB_TOKEN: string;
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  DEFAULT_TAXONOMY: string;
  FAVICON_TEMPLATE: string;
  REPO: string;
  DB: D1Database;
  // Assets 绑定（wrangler 依 assets.directory 自动注入）：index.ts 处理 /admin 改写时使用；
  // 测试配置（test/wrangler.routes.json）无 assets，运行时以 `env.ASSETS &&` 存在性守卫
  ASSETS: Fetcher;
}
