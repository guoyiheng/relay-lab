import { getRouterParam, readBody } from 'h3'
import { useDb } from '~~/server/utils/db'
import { requireUserId } from '~~/server/utils/auth'

// Toggle / set a task's favorite flag. Body: { favorite: boolean }.
export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  if (event.method !== 'POST') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }
  const id = Number(getRouterParam(event, 'id'))
  if (!id || Number.isNaN(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
  }
  const body = await readBody<{ favorite?: boolean }>(event)
  const fav = body?.favorite ? 1 : 0
  await useDb().prepare('UPDATE tasks SET favorite = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(fav, Date.now(), id, userId)
  return { ok: true, favorite: !!fav }
})
