/// <reference types="@cloudflare/workers-types" />
import { useBucket, useDb, type Db } from './db'
import { keyFromUrl } from './storage'

export const ASSET_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const ASSET_CLEANUP_REASON = '根据存储空间保留策略，非 xxn 用户的测试素材仅保留 7 天；素材已自动清理，任务记录仍然保留。'

interface DueTaskRow {
  id: number
  user_id: number
  result_urls: string | null
}

interface StoredAssetRow {
  id: string
  r2_key: string
  expires_at?: number | null
  ref_count?: number
}

export interface AssetCleanupResult {
  tasksCleaned: number
  assetsDeleted: number
  r2ObjectsDeleted: number
}

function uniqueKeys(rows: Array<Pick<StoredAssetRow, 'r2_key'>>): string[] {
  return Array.from(new Set(rows.map((row) => row.r2_key).filter(Boolean)))
}

function storedResultKeys(raw: string | null): string[] {
  if (!raw) return []
  try {
    const urls = JSON.parse(raw)
    if (!Array.isArray(urls)) return []
    return Array.from(new Set(urls
      .filter((url): url is string => typeof url === 'string')
      .map((url) => keyFromUrl(url))
      .filter((key): key is string => !!key)))
  } catch {
    return []
  }
}

async function deleteR2Keys(bucket: R2Bucket, keys: string[]): Promise<void> {
  if (!keys.length) return
  for (let i = 0; i < keys.length; i += 500) {
    await bucket.delete(keys.slice(i, i + 500))
  }
}

/**
 * Delete expired media while preserving task rows and their audit metadata.
 *
 * Idempotency: R2 deletes may be repeated; a task is marked cleaned only after
 * its object deletion succeeds. A failed run is retried by the next cron.
 */
export async function cleanupExpiredAssets(options: {
  now?: number
  taskLimit?: number
  orphanLimit?: number
  db?: Db
  bucket?: R2Bucket
} = {}): Promise<AssetCleanupResult> {
  const now = options.now ?? Date.now()
  const taskLimit = Math.min(Math.max(options.taskLimit ?? 100, 1), 500)
  const orphanLimit = Math.min(Math.max(options.orphanLimit ?? 500, 1), 1000)
  const db = options.db ?? useDb()
  const bucket = options.bucket ?? useBucket()
  const result: AssetCleanupResult = { tasksCleaned: 0, assetsDeleted: 0, r2ObjectsDeleted: 0 }

  const dueTasks = await db.prepare(`
    SELECT t.id, t.user_id, t.result_urls
    FROM tasks t
    JOIN users u ON u.id = t.user_id
    WHERE u.username <> 'xxn'
      AND t.assets_expires_at IS NOT NULL
      AND t.assets_expires_at <= ?
      AND t.assets_cleaned_at IS NULL
      AND t.status IN ('succeeded', 'failed')
      AND (
        t.kind <> 'text'
        OR (t.result_urls IS NOT NULL AND t.result_urls NOT IN ('', '[]', 'null'))
        OR EXISTS (
          SELECT 1 FROM task_assets ta
          WHERE ta.user_id = t.user_id AND ta.task_id = t.id
        )
        OR EXISTS (
          SELECT 1 FROM assets a
          WHERE a.user_id = t.user_id AND a.task_id = t.id AND a.source = 'generated'
        )
      )
    ORDER BY t.assets_expires_at ASC
    LIMIT ${taskLimit}
  `).all(now) as DueTaskRow[]

  for (const task of dueTasks) {
    // A generated asset reused by a newer task is retained until that newer
    // task releases it. Its expires_at is extended when the reference is made.
    const generatedRows = await db.prepare(`
      SELECT a.id, a.r2_key, a.expires_at,
             (SELECT COUNT(*) FROM task_assets ta
               WHERE ta.user_id = a.user_id AND ta.asset_id = a.id) AS ref_count
      FROM assets a
      WHERE a.user_id = ? AND a.task_id = ? AND a.source = 'generated'
    `).all(task.user_id, task.id) as StoredAssetRow[]
    const generated = generatedRows.filter((asset) =>
      (asset.expires_at == null || asset.expires_at <= now) && !asset.ref_count,
    )
    const retainedKeys = new Set(
      generatedRows
        .filter((asset) => !generated.some((candidate) => candidate.id === asset.id))
        .map((asset) => asset.r2_key),
    )
    // result_urls is a recovery path for the rare partial failure where R2 put
    // succeeded but the generated assets row was never registered.
    const r2Keys = Array.from(new Set([
      ...uniqueKeys(generated),
      ...storedResultKeys(task.result_urls).filter((key) => !retainedKeys.has(key)),
    ]))

    // Delete bytes first. If R2 is temporarily unavailable, leave D1 untouched
    // so the UI does not claim cleanup succeeded before the bytes are gone.
    await deleteR2Keys(bucket, r2Keys)

    const statements: D1PreparedStatement[] = [
      db.d1.prepare('DELETE FROM task_assets WHERE user_id = ? AND task_id = ?').bind(task.user_id, task.id),
      db.d1.prepare(`
        UPDATE tasks
        SET result_urls = '[]', assets_cleaned_at = ?, assets_cleanup_reason = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND assets_cleaned_at IS NULL
      `).bind(now, ASSET_CLEANUP_REASON, now, task.id, task.user_id),
    ]
    if (generated.length) {
      const placeholders = generated.map(() => '?').join(',')
      statements.splice(1, 0,
        db.d1.prepare(`DELETE FROM assets WHERE user_id = ? AND id IN (${placeholders})`)
          .bind(task.user_id, ...generated.map((asset) => asset.id)),
      )
    }
    await db.batch(statements)

    result.tasksCleaned += 1
    result.assetsDeleted += generated.length
    result.r2ObjectsDeleted += r2Keys.length
  }

  // Local uploads have no owning task. Generated rows can outlive their source
  // task when reused; once the final reference is detached, this sweep removes
  // those expired rows and R2 objects too.
  const orphans = await db.prepare(`
    SELECT a.id, a.r2_key
    FROM assets a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN tasks source_task
      ON source_task.id = a.task_id AND source_task.user_id = a.user_id
    WHERE u.username <> 'xxn'
      AND a.expires_at IS NOT NULL
      AND a.expires_at <= ?
      AND (a.source = 'local' OR source_task.assets_cleaned_at IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM task_assets ta
        WHERE ta.user_id = a.user_id AND ta.asset_id = a.id
      )
    ORDER BY a.expires_at ASC
    LIMIT ${orphanLimit}
  `).all(now) as StoredAssetRow[]

  if (orphans.length) {
    const r2Keys = uniqueKeys(orphans)
    await deleteR2Keys(bucket, r2Keys)
    const placeholders = orphans.map(() => '?').join(',')
    await db.prepare(`DELETE FROM assets WHERE id IN (${placeholders})`).run(...orphans.map((row) => row.id))
    result.assetsDeleted += orphans.length
    result.r2ObjectsDeleted += r2Keys.length
  }

  return result
}
