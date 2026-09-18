import { useDb } from '~~/server/utils/db'
import { requireUserId } from '~~/server/utils/auth'
export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const id = Number(getRouterParam(event, 'id'))
  const body = await readBody<{ message?: string }>(event)
  const message = String(body?.message || '任务处理失败').slice(0, 500)
  await useDb().prepare("UPDATE tasks SET status = 'failed', error_message = ?, finished_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND status IN ('pending','running')").run(message, Date.now(), Date.now(), id, userId)
  return { ok: true }
})
