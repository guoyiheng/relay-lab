import { useDb } from '~~/server/utils/db'
import { getCurrentUser } from '~~/server/utils/auth'

export default defineEventHandler(async (event) => {
  const user = await getCurrentUser(event)
  if (!user) throw createError({ statusCode: 401, statusMessage: '未登录' })

  const body = await readBody<{
    event_type: string
    event_name: string
    page?: string
    element?: string
    metadata?: Record<string, unknown>
    duration_ms?: number
  }>(event)

  const db = useDb()
  const now = Date.now()

  await db.prepare(
    `INSERT INTO analytics_events (user_id, event_type, event_name, page, element, metadata, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    user.id,
    body.event_type,
    body.event_name,
    body.page || null,
    body.element || null,
    body.metadata ? JSON.stringify(body.metadata) : null,
    body.duration_ms || null,
    now,
  )

  return { ok: true }
})
