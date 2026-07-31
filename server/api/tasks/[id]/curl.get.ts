import { getRouterParam } from 'h3'
import { useDb, type TaskRecord } from '~~/server/utils/db'
import { requireUserId } from '~~/server/utils/auth'
import { shellSingleQuote, taskEndpoint } from '~~/shared/task-curl'

// Returns a ready-to-paste curl for a task. Includes the real Authorization
// header so the user can paste into a terminal and it just works.
// Only logged-in users hit this (middleware already gated /api/* except auth).
interface JoinedRow extends TaskRecord {
  provider_base_url: string | null
  provider_api_key: string | null
  model_keys: string | null
}

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!id || Number.isNaN(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
  }
  const row = await useDb().prepare(`
    SELECT t.*,
           p.base_url AS provider_base_url,
           p.api_key  AS provider_api_key,
           m.keys     AS model_keys
    FROM tasks t LEFT JOIN providers p ON p.id = t.provider_id AND p.user_id = t.user_id
                 LEFT JOIN models m ON m.id = t.model_id AND m.user_id = t.user_id
    WHERE t.id = ? AND t.user_id = ? AND t.deleted_at IS NULL
  `).get(id, userId) as JoinedRow | null
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Task not found' })

  let requestPayload: unknown = row.request_payload
  try { requestPayload = row.request_payload ? JSON.parse(row.request_payload) : null } catch { /* use raw value */ }
  const ep = taskEndpoint({ ...row, request_payload: requestPayload }, row.provider_base_url || '')
  if (!ep) return { curl: '', endpoint: null }

  let apiKey = row.provider_api_key || ''
  if (row.model_keys) {
    try {
      const keys = JSON.parse(row.model_keys) as Array<{ key?: string; enabled?: boolean }>
      apiKey = keys.find((key) => key.enabled !== false && key.key)?.key || apiKey
    } catch { /* fall back to provider key */ }
  }
  const bodyJson = row.request_payload || '{}'
  const curl = [
    `curl -X ${ep.method} ${shellSingleQuote(ep.url)} \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H ${shellSingleQuote(`Authorization: Bearer ${apiKey}`)} \\`,
    `  -d ${shellSingleQuote(bodyJson)}`,
  ].join('\n')

  return { curl, endpoint: ep }
})
