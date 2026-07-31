-- Relay Lab · D1 初始 schema（终态）
-- 由 better-sqlite3 单文件迁移而来：这里直接建最终列集，不再保留历史 ALTER 迁移。
-- 与旧 SQLite 的差异：uploads 去掉 data BLOB、改存 r2_key（字节落 R2）。
-- 存量数据由一次性迁移脚本导入（见部署第 7 步），故此处不做种子。
-- 应用：  wrangler d1 migrations apply relay-lab --local / --remote

CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  api_format TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT,
  kind TEXT NOT NULL,
  default_params TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  price_mode TEXT,
  price_cny REAL,
  price_in_cny REAL,
  price_out_cny REAL,
  price_novideo_cny REAL,
  price_video_cny REAL,
  polish_model INTEGER NOT NULL DEFAULT 0,
  keys TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER,
  provider_name TEXT NOT NULL,
  model_id INTEGER,
  model_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  api_format TEXT NOT NULL,
  prompt TEXT NOT NULL,
  params TEXT,
  request_payload TEXT,
  response_payload TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  latency_ms INTEGER,
  remote_task_id TEXT,
  result_urls TEXT,
  result_text TEXT,
  error_message TEXT,
  analysis TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  price_mode TEXT,
  price_cny REAL,
  price_in_cny REAL,
  price_out_cny REAL,
  price_novideo_cny REAL,
  price_video_cny REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  deleted_at INTEGER,
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE SET NULL,
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  avatar TEXT,
  nickname TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- assets：本地上传 + 生成结果统一表。字节存 R2（key = r2_key），D1 仅留元数据。
--   source='local'     用户上传/站外导入的素材；task_id/result_idx 为 NULL
--   source='generated' 任务生成的结果；task_id+result_idx 指向来源任务的第 idx 个结果，
--                       r2_key 即该结果在 R2 的对象（与 tasks.result_urls 共用，不重复存储）
-- 「素材是否有 id」= 是否在本表有行 → 统一用 asset id 引用（含把生成结果复用为参考）。
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'local',
  kind TEXT NOT NULL,
  filename TEXT,
  mime TEXT,
  size INTEGER,
  width INTEGER,
  height INTEGER,
  sha256 TEXT,
  r2_key TEXT NOT NULL,
  task_id INTEGER,
  result_idx INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS task_assets (
  task_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  idx INTEGER NOT NULL,
  asset_id TEXT NOT NULL,
  PRIMARY KEY (task_id, kind, idx),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- 成本表（另一平台参考数据，本项目仅维护展示）
CREATE TABLE IF NOT EXISTS cost_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT,
  price_mode TEXT,
  resolution TEXT,
  duration_s REAL,
  cost_cny REAL NOT NULL,
  points INTEGER,
  note TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_name TEXT NOT NULL,
  page TEXT,
  element TEXT,
  metadata TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_models_unique ON models(provider_id, model_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_provider ON tasks(provider_id);
CREATE INDEX IF NOT EXISTS idx_tasks_model ON tasks(model_id);
CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(kind);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_sha ON assets(sha256);
CREATE INDEX IF NOT EXISTS idx_assets_kind ON assets(kind);
CREATE INDEX IF NOT EXISTS idx_assets_task ON assets(task_id);
-- 生成素材每任务每下标唯一，结果转存可 INSERT OR IGNORE 幂等登记
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_task_result ON assets(task_id, result_idx);
CREATE INDEX IF NOT EXISTS idx_task_assets_task ON task_assets(task_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user ON analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events(created_at DESC);
