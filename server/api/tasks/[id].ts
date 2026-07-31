import { useDb, useBucket, type TaskRecord } from '~~/server/utils/db'
import { serializeTask } from '~~/server/utils/serialize'
import { loadTaskRefs } from '~~/server/utils/refs'
import { reapStaleTasks } from '~~/server/utils/reaper'
import { requireUserId } from '~~/server/utils/auth'

interface JoinedRow extends TaskRecord {
  provider_base_url: string | null
  live_provider_name: string | null
  live_model_name: string | null
}

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!id || Number.isNaN(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
  }
  const db = useDb()
  if (event.method === 'GET') {
    // Names are live-joined (renames propagate); PRICE comes from the task's
    // own snapshot columns (t.price_*), not from models.
    const row = await db.prepare(`
      SELECT t.*,
             p.base_url AS provider_base_url,
             p.name AS live_provider_name,
             COALESCE(m.display_name, m.model_id) AS live_model_name
      FROM tasks t
      LEFT JOIN providers p ON p.id = t.provider_id AND p.user_id = t.user_id
      LEFT JOIN models m ON m.id = t.model_id AND m.user_id = t.user_id
      WHERE t.id = ? AND t.user_id = ? AND t.deleted_at IS NULL
    `).get(id, userId) as JoinedRow | null
    if (!row) throw createError({ statusCode: 404, statusMessage: 'Task not found' })
    // 惰性回收僵尸任务（就地改写 row 状态，序列化即反映失败态）。
    await reapStaleTasks([row], userId)
    const refsMap = await loadTaskRefs([id], userId)
    const refs = refsMap.get(id)
    return {
      ...serializeTask(row, {
        providerBaseUrl: row.provider_base_url,
        providerName: row.live_provider_name,
        modelName: row.live_model_name,
      }),
      refs,
    }
  }
  if (event.method === 'DELETE') {
    // Soft-delete the task (row + result media kept for audit/recovery), but
    // its reference assets are detached and any now-orphan LOCAL asset is removed
    // so the library / @ list don't show dangling refs. D1 无交互式事务：先查出
    // 「只被本任务引用」的本地素材（含 r2_key），再 batch 删库，最后释放 R2 对象。
    // 只清 source='local' 孤儿：generated 素材归属其来源任务（task_id/result_idx），
    // 不因某个引用它的任务被删而清除（其字节仍被来源任务的 result_urls 缓存引用）。
    const orphans = await db.prepare(`
      SELECT DISTINCT a.id AS id, a.r2_key AS r2_key
      FROM task_assets ta JOIN assets a ON a.id = ta.asset_id
      WHERE ta.task_id = ? AND ta.user_id = ? AND a.source = 'local'
        AND NOT EXISTS (SELECT 1 FROM task_assets t2 WHERE t2.asset_id = ta.asset_id AND t2.task_id <> ? AND t2.user_id = ?)
    `).all(id, userId, id, userId) as { id: string; r2_key: string }[]

    const stmts = [
      db.d1.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ? AND user_id = ?').bind(Date.now(), id, userId),
      db.d1.prepare('DELETE FROM task_assets WHERE task_id = ? AND user_id = ?').bind(id, userId),
    ]
    if (orphans.length) {
      const ph = orphans.map(() => '?').join(',')
      stmts.push(db.d1.prepare(`DELETE FROM assets WHERE user_id = ? AND id IN (${ph})`).bind(userId, ...orphans.map((o) => o.id)))
    }
    await db.batch(stmts)

    for (const o of orphans) {
      if (o.r2_key) { try { await useBucket().delete(o.r2_key) } catch { /* ignore */ } }
    }
    return { ok: true }
  }
  throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
})
