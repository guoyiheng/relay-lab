import { useDb } from '~~/server/utils/db'
import { getCurrentUser } from '~~/server/utils/auth'

export default defineEventHandler(async (event) => {
  const user = await getCurrentUser(event)
  if (!user) throw createError({ statusCode: 401, statusMessage: '未登录' })
  if (user.username !== 'xxn') throw createError({ statusCode: 403, statusMessage: '无权访问' })

  const db = useDb()
  const events = await db
    .prepare(`
      SELECT ae.*, u.username
      FROM analytics_events ae
      JOIN users u ON u.id = ae.user_id
      ORDER BY ae.created_at DESC
      LIMIT 500
    `)
    .all() as any[]

  return {
    events: events.map((e) => ({
      id: e.id,
      username: e.username,
      event_type: e.event_type,
      event_name: e.event_name,
      page: e.page,
      element: e.element,
      metadata: e.metadata ? JSON.parse(e.metadata) : null,
      duration_ms: e.duration_ms,
      created_at: e.created_at,
    })),
  }
})
