import { getRouterParam } from 'h3'
import { useDb, useBucket } from '~~/server/utils/db'
import { requireUserId } from '~~/server/utils/auth'

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  if (event.method !== 'DELETE') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })
  const db = useDb()
  // 先取 r2_key（删 D1 行后就查不到了），用于释放 R2 对象。
  const row = await db.prepare('SELECT r2_key FROM assets WHERE id = ? AND user_id = ?').get(id, userId) as { r2_key: string } | null
  // task_assets 的 ON DELETE CASCADE 挂在 tasks 上、不在 assets 上，需手动清引用。
  // D1 无交互式事务，用 batch 打包这两条静态删除。
  await db.batch([
    db.d1.prepare('DELETE FROM task_assets WHERE asset_id = ? AND user_id = ?').bind(id, userId),
    db.d1.prepare('DELETE FROM assets WHERE id = ? AND user_id = ?').bind(id, userId),
  ])
  if (row?.r2_key) {
    try { await useBucket().delete(row.r2_key) } catch { /* 释放失败不阻断 */ }
  }
  return { ok: true }
})
