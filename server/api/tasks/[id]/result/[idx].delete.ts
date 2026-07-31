import { getRouterParam } from 'h3'
import { useDb, useBucket } from '~~/server/utils/db'
import { keyFromUrl } from '~~/server/utils/storage'
import { requireUserId } from '~~/server/utils/auth'

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  if (event.method !== 'DELETE') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }
  const taskId = Number(getRouterParam(event, 'id'))
  const idx = Number(getRouterParam(event, 'idx'))
  if (!taskId || Number.isNaN(taskId)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid task id' })
  }
  if (Number.isNaN(idx) || idx < 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid result index' })
  }
  const db = useDb()
  const row = await db.prepare('SELECT result_urls FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId) as { result_urls: string | null } | null
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Task not found' })
  let urls: string[] = []
  try {
    const parsed = JSON.parse(row.result_urls || '[]')
    if (Array.isArray(parsed)) urls = parsed
  } catch { /* ignore */ }
  if (idx >= urls.length) throw createError({ statusCode: 404, statusMessage: 'Result index out of range' })
  const [removed] = urls.splice(idx, 1)
  if (!removed) throw createError({ statusCode: 404, statusMessage: 'Result index out of range' })

  // 找出「只被本任务引用」的本地参考素材（含 r2_key），仅在清空结果时才会释放。
  // 只清 source='local'；生成素材归属来源任务，不在此按引用清。
  let orphans: { id: string; r2_key: string }[] = []
  if (urls.length === 0) {
    orphans = await db.prepare(`
      SELECT DISTINCT a.id AS id, a.r2_key AS r2_key
      FROM task_assets ta JOIN assets a ON a.id = ta.asset_id
      WHERE ta.task_id = ? AND ta.user_id = ? AND a.source = 'local'
        AND NOT EXISTS (SELECT 1 FROM task_assets t2 WHERE t2.asset_id = ta.asset_id AND t2.task_id <> ? AND t2.user_id = ?)
    `).all(taskId, userId, taskId, userId) as { id: string; r2_key: string }[]
  }

  const stmts = [
    db.d1.prepare('UPDATE tasks SET result_urls = ?, updated_at = ? WHERE id = ? AND user_id = ?').bind(JSON.stringify(urls), Date.now(), taskId, userId),
    // 删掉这一路结果对应的 generated 素材行（它作为可复用素材已随结果一起消失）。
    db.d1.prepare(`DELETE FROM assets WHERE source = 'generated' AND task_id = ? AND result_idx = ? AND user_id = ?`).bind(taskId, idx, userId),
  ]
  if (urls.length === 0) {
    stmts.push(db.d1.prepare('DELETE FROM task_assets WHERE task_id = ? AND user_id = ?').bind(taskId, userId))
    if (orphans.length) {
      const ph = orphans.map(() => '?').join(',')
      stmts.push(db.d1.prepare(`DELETE FROM assets WHERE user_id = ? AND id IN (${ph})`).bind(userId, ...orphans.map((o) => o.id)))
    }
  }
  await db.batch(stmts)

  // 释放 R2：被删的这一路生成结果对象 + 变孤儿的参考素材对象（best-effort）。
  const bucket = useBucket()
  const removedKey = keyFromUrl(removed)
  if (removedKey) { try { await bucket.delete(removedKey) } catch { /* ignore */ } }
  for (const o of orphans) {
    if (o.r2_key) { try { await bucket.delete(o.r2_key) } catch { /* ignore */ } }
  }

  return { ok: true, remaining: urls.length }
})
