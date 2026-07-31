-- 非管理员用户素材保留策略：任务与素材保留 7 天，xxn 永久保留。
-- 清理任务只删除 R2 对象、assets/task_assets 关系和结果链接，不删除 tasks 记录。

ALTER TABLE tasks ADD COLUMN assets_expires_at INTEGER;
ALTER TABLE tasks ADD COLUMN assets_cleaned_at INTEGER;
ALTER TABLE tasks ADD COLUMN assets_cleanup_reason TEXT;
ALTER TABLE assets ADD COLUMN expires_at INTEGER;

-- 历史数据按原创建时间回填。已经超过 7 天的内容会在下一次 cron 中被清理。
UPDATE tasks
SET assets_expires_at = created_at + 604800000
WHERE user_id IN (SELECT id FROM users WHERE username <> 'xxn');

UPDATE assets
SET expires_at = CASE
  WHEN task_id IS NOT NULL THEN COALESCE(
    (SELECT t.assets_expires_at FROM tasks t WHERE t.id = assets.task_id),
    created_at + 604800000
  )
  ELSE created_at + 604800000
END
WHERE user_id IN (SELECT id FROM users WHERE username <> 'xxn');

-- 历史素材若被更晚创建的任务复用，应至少保留到最新引用任务的到期时间。
UPDATE assets
SET expires_at = MAX(
  expires_at,
  (SELECT MAX(t.assets_expires_at)
     FROM task_assets ta
     JOIN tasks t ON t.id = ta.task_id AND t.user_id = ta.user_id
    WHERE ta.user_id = assets.user_id AND ta.asset_id = assets.id)
)
WHERE user_id IN (SELECT id FROM users WHERE username <> 'xxn')
  AND EXISTS (
    SELECT 1
    FROM task_assets ta
    JOIN tasks t ON t.id = ta.task_id AND t.user_id = ta.user_id
    WHERE ta.user_id = assets.user_id
      AND ta.asset_id = assets.id
      AND t.assets_expires_at > assets.expires_at
  );

CREATE INDEX IF NOT EXISTS idx_tasks_assets_expiry
  ON tasks(assets_expires_at, assets_cleaned_at);
CREATE INDEX IF NOT EXISTS idx_assets_expiry
  ON assets(expires_at, user_id);

-- 即使未来新增写入入口忘记显式设置，也由数据库保证非 xxn 用户拥有 7 天期限。
CREATE TRIGGER IF NOT EXISTS tasks_retention_after_insert
AFTER INSERT ON tasks
WHEN EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.username <> 'xxn')
  AND NEW.assets_expires_at IS NULL
BEGIN
  UPDATE tasks
  SET assets_expires_at = NEW.created_at + 604800000
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS assets_retention_after_insert
AFTER INSERT ON assets
WHEN EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.username <> 'xxn')
  AND NEW.expires_at IS NULL
BEGIN
  UPDATE assets
  SET expires_at = CASE
    WHEN NEW.task_id IS NOT NULL THEN COALESCE(
      (SELECT t.assets_expires_at FROM tasks t WHERE t.id = NEW.task_id),
      NEW.created_at + 604800000
    )
    ELSE NEW.created_at + 604800000
  END
  WHERE id = NEW.id;
END;
