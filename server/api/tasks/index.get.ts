import { useDb, type TaskRecord } from '~~/server/utils/db'
import { serializeTask } from '~~/server/utils/serialize'
import { reapStaleTasks } from '~~/server/utils/reaper'
import { requireUserId } from '~~/server/utils/auth'

interface JoinedRow extends TaskRecord {
  provider_base_url: string | null
  live_provider_name: string | null
  live_model_name: string | null
}

// List views intentionally exclude the two potentially very large provider
// payload snapshots. Full request/response data and reference assets are loaded
// from GET /api/tasks/:id only after the user opens a task. Selecting explicit
// columns also prevents D1 from shipping those large strings to the Worker.
const TASK_LIST_COLUMNS = `
  t.id,
  t.user_id,
  t.provider_id,
  t.provider_name,
  t.model_id,
  t.model_name,
  t.kind,
  t.api_format,
  t.prompt,
  t.params,
  NULL AS request_payload,
  NULL AS response_payload,
  t.status,
  t.http_status,
  t.latency_ms,
  t.remote_task_id,
  t.result_urls,
  t.result_text,
  t.error_message,
  t.analysis,
  t.favorite,
  t.price_mode,
  t.price_cny,
  t.price_in_cny,
  t.price_out_cny,
  t.price_novideo_cny,
  t.price_video_cny,
  t.created_at,
  t.updated_at,
  t.finished_at,
  t.deleted_at,
  t.assets_expires_at,
  t.assets_cleaned_at,
  t.assets_cleanup_reason
`

export default defineEventHandler(async (event) => {
  const startedAt = performance.now()
  const userId = requireUserId(event)
  const query = getQuery(event)
  const db = useDb()
  const where: string[] = ['t.user_id = ?', 't.deleted_at IS NULL']
  const args: unknown[] = [userId]
  if (query.provider_id) { where.push('t.provider_id = ?'); args.push(Number(query.provider_id)) }
  if (query.model_id) { where.push('t.model_id = ?'); args.push(Number(query.model_id)) }
  if (query.kind) { where.push('t.kind = ?'); args.push(String(query.kind)) }
  if (query.status) { where.push('t.status = ?'); args.push(String(query.status)) }
  // 合并轮询：前端传 ids=1,2,3 一次拉回一组任务（未终态任务批量刷新用）。
  const idList = String(query.ids || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
  if (idList.length) {
    where.push(`t.id IN (${idList.map(() => '?').join(',')})`)
    args.push(...idList)
  }
  const limit = Math.min(Math.max(Number(query.limit) || 60, 1), 300)
  // Names are live-joined (renames propagate); PRICE is read from the task's
  // own snapshot columns (t.price_*), not joined from models.
  const sql = `
    SELECT ${TASK_LIST_COLUMNS},
           p.base_url AS provider_base_url,
           p.name AS live_provider_name,
           COALESCE(m.display_name, m.model_id) AS live_model_name
    FROM tasks t
    LEFT JOIN providers p ON p.id = t.provider_id AND p.user_id = t.user_id
    LEFT JOIN models m ON m.id = t.model_id AND m.user_id = t.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY t.created_at DESC
    LIMIT ${limit}
  `
  const rows = await db.prepare(sql).all(...args) as JoinedRow[]
  // 惰性回收僵尸任务（就地改写 rows 的状态，序列化即反映失败态）。
  await reapStaleTasks(rows, userId)
  const body = rows.map((r) => serializeTask(r, {
    providerBaseUrl: r.provider_base_url,
    providerName: r.live_provider_name,
    modelName: r.live_model_name,
  }))
  appendHeader(event, 'Server-Timing', `app;dur=${(performance.now() - startedAt).toFixed(1)};desc="task-list"`)
  return body
})
