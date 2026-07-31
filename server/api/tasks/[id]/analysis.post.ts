import { getRouterParam } from 'h3'
import { useDb } from '~~/server/utils/db'
import { requireUserId } from '~~/server/utils/auth'

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const taskId = Number(getRouterParam(event, 'id'))
  if (!taskId || Number.isNaN(taskId)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid task id' })
  }
  const body = await readBody<{ analysis?: unknown }>(event)
  if (!body?.analysis || typeof body.analysis !== 'object') {
    throw createError({ statusCode: 400, statusMessage: '缺少 analysis 内容' })
  }
  const db = useDb()
  const row = await db.prepare('SELECT id FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId) as { id: number } | null
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Task not found' })
  await db.prepare('UPDATE tasks SET analysis = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(JSON.stringify(body.analysis), Date.now(), taskId, userId)
  return { ok: true }
})
