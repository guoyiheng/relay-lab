-- 多用户邮箱注册与数据隔离。
-- 现有单用户数据统一归属 xxn；新写入必须由应用显式携带 user_id。

ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
ALTER TABLE users ADD COLUMN storage_namespace TEXT;
UPDATE users
SET email = CASE WHEN instr(username, '@') > 0 THEN lower(username) ELSE email END,
    storage_namespace = COALESCE(storage_namespace, lower(hex(randomblob(16))));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
  ON users(lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_storage_namespace
  ON users(storage_namespace) WHERE storage_namespace IS NOT NULL;

ALTER TABLE providers ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE models ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE tasks ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE assets ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE task_assets ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

UPDATE providers SET user_id = (SELECT id FROM users WHERE username = 'xxn' LIMIT 1) WHERE user_id IS NULL;
UPDATE models SET user_id = (SELECT id FROM users WHERE username = 'xxn' LIMIT 1) WHERE user_id IS NULL;
UPDATE tasks SET user_id = (SELECT id FROM users WHERE username = 'xxn' LIMIT 1) WHERE user_id IS NULL;
UPDATE assets SET user_id = (SELECT id FROM users WHERE username = 'xxn' LIMIT 1) WHERE user_id IS NULL;
UPDATE task_assets
SET user_id = (SELECT user_id FROM tasks WHERE tasks.id = task_assets.task_id)
WHERE user_id IS NULL;

DROP INDEX IF EXISTS idx_models_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_providers_user_name ON providers(user_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_models_user_unique ON models(user_id, provider_id, model_id);
CREATE INDEX IF NOT EXISTS idx_providers_user ON providers(user_id);
CREATE INDEX IF NOT EXISTS idx_models_user ON models(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_assets_user_created ON assets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_user_sha ON assets(user_id, sha256, kind);
CREATE INDEX IF NOT EXISTS idx_task_assets_user_task ON task_assets(user_id, task_id);

-- 阻止模型、任务、素材引用其他用户的数据。API 层仍会做同样的所有权过滤；
-- 触发器是数据库侧的最后一道防线。
CREATE TRIGGER IF NOT EXISTS providers_owner_guard_insert
BEFORE INSERT ON providers
WHEN NEW.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'provider owner mismatch'); END;

CREATE TRIGGER IF NOT EXISTS providers_owner_guard_update
BEFORE UPDATE OF user_id ON providers
WHEN NEW.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'provider owner mismatch'); END;

CREATE TRIGGER IF NOT EXISTS models_owner_guard_insert
BEFORE INSERT ON models
WHEN NEW.user_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM providers p WHERE p.id = NEW.provider_id AND p.user_id = NEW.user_id
)
BEGIN SELECT RAISE(ABORT, 'model owner mismatch'); END;

CREATE TRIGGER IF NOT EXISTS models_owner_guard_update
BEFORE UPDATE OF user_id, provider_id ON models
WHEN NEW.user_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM providers p WHERE p.id = NEW.provider_id AND p.user_id = NEW.user_id
)
BEGIN SELECT RAISE(ABORT, 'model owner mismatch'); END;

CREATE TRIGGER IF NOT EXISTS tasks_owner_guard_insert
BEFORE INSERT ON tasks
WHEN NEW.user_id IS NULL
  OR (NEW.provider_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM providers p WHERE p.id = NEW.provider_id AND p.user_id = NEW.user_id
  ))
  OR (NEW.model_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM models m WHERE m.id = NEW.model_id AND m.user_id = NEW.user_id
  ))
BEGIN SELECT RAISE(ABORT, 'task owner mismatch'); END;

CREATE TRIGGER IF NOT EXISTS tasks_owner_guard_update
BEFORE UPDATE OF user_id, provider_id, model_id ON tasks
WHEN NEW.user_id IS NULL
  OR (NEW.provider_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM providers p WHERE p.id = NEW.provider_id AND p.user_id = NEW.user_id
  ))
  OR (NEW.model_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM models m WHERE m.id = NEW.model_id AND m.user_id = NEW.user_id
  ))
BEGIN SELECT RAISE(ABORT, 'task owner mismatch'); END;

CREATE TRIGGER IF NOT EXISTS assets_owner_guard_insert
BEFORE INSERT ON assets
WHEN NEW.user_id IS NULL
  OR (NEW.task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tasks t WHERE t.id = NEW.task_id AND t.user_id = NEW.user_id
  ))
BEGIN SELECT RAISE(ABORT, 'asset owner mismatch'); END;

CREATE TRIGGER IF NOT EXISTS assets_owner_guard_update
BEFORE UPDATE OF user_id, task_id ON assets
WHEN NEW.user_id IS NULL
  OR (NEW.task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tasks t WHERE t.id = NEW.task_id AND t.user_id = NEW.user_id
  ))
BEGIN SELECT RAISE(ABORT, 'asset owner mismatch'); END;

CREATE TRIGGER IF NOT EXISTS task_assets_owner_guard_insert
BEFORE INSERT ON task_assets
WHEN NEW.user_id IS NULL OR NOT EXISTS (
  SELECT 1
  FROM tasks t JOIN assets a ON a.id = NEW.asset_id
  WHERE t.id = NEW.task_id
    AND t.user_id = NEW.user_id
    AND a.user_id = NEW.user_id
)
BEGIN SELECT RAISE(ABORT, 'task asset owner mismatch'); END;

CREATE TRIGGER IF NOT EXISTS task_assets_owner_guard_update
BEFORE UPDATE OF user_id, task_id, asset_id ON task_assets
WHEN NEW.user_id IS NULL OR NOT EXISTS (
  SELECT 1
  FROM tasks t JOIN assets a ON a.id = NEW.asset_id
  WHERE t.id = NEW.task_id
    AND t.user_id = NEW.user_id
    AND a.user_id = NEW.user_id
)
BEGIN SELECT RAISE(ABORT, 'task asset owner mismatch'); END;

-- 待验证注册不保存明文验证码/令牌，只保存 SHA-256 摘要；15 分钟后失效。
CREATE TABLE IF NOT EXISTS pending_registrations (
  email TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  request_ip_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_registrations_expires ON pending_registrations(expires_at);

-- 防止公开注册接口被滥用来消耗 Resend 额度：同一 IP 每日最多发送 30 封验证邮件。
CREATE TABLE IF NOT EXISTS registration_email_ip_days (
  ip_hash TEXT NOT NULL,
  day_key TEXT NOT NULL,
  send_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, day_key)
);

-- 每个 IP 每个中国时区自然日最多占用 10 个槽位。slot 的唯一键使并发注册也不能超过 10。
CREATE TABLE IF NOT EXISTS registration_ip_slots (
  ip_hash TEXT NOT NULL,
  day_key TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 10),
  email TEXT NOT NULL,
  user_id INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, day_key, slot),
  UNIQUE (email),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_registration_ip_slots_created ON registration_ip_slots(created_at);
