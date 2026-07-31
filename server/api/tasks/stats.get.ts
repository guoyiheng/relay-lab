import { useDb } from '~~/server/utils/db'
import { requireUserId } from '~~/server/utils/auth'

interface StatsRow {
  provider_id: number | null
  provider_name: string
  api_format: string
  kind: string
  model_id: number | null
  model_name: string
  total: number
  succeeded: number
  failed: number
  avg_latency_ms: number | null
  p50_latency_ms: number | null
  last_run_at: number | null
}

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const query = getQuery(event)
  const where: string[] = ['t.user_id = ?', 't.deleted_at IS NULL']
  const args: any[] = [userId]
  if (query.kind) { where.push('t.kind = ?'); args.push(String(query.kind)) }
  if (query.since) {
    const since = Number(query.since)
    if (since) { where.push('t.created_at >= ?'); args.push(since) }
  }
  const db = useDb()
  // Group by live provider name + MODEL (COALESCE → snapshot when deleted) so
  // renames reflect, and each model is its own stats row (kind shown as a badge).
  //
  // IMPORTANT: GROUP BY must reference the full COALESCE expressions — NOT the
  // bare `provider_name` / `model_name` aliases. SQLite resolves a bare alias
  // that collides with a real table column (`tasks.provider_name`,
  // `tasks.model_name`) to the RAW column (the per-task snapshot), not the
  // SELECT alias. That caused a provider rename (e.g. "T8 Star" → "T8") to split
  // one model into two rows that both DISPLAY as "T8" (live name) but group on
  // the differing snapshot — the duplicate-row bug. Grouping on the live-name
  // expression (with snapshot fallback) collapses them back into one row.
  const rows = await db
    .prepare(
      `SELECT
         t.provider_id AS provider_id,
         COALESCE(p.name, t.provider_name) AS provider_name,
         t.api_format AS api_format,
         t.kind AS kind,
         t.model_id AS model_id,
         COALESCE(m.display_name, m.model_id, t.model_name) AS model_name,
         COUNT(*) as total,
         SUM(CASE WHEN t.status = 'succeeded' THEN 1 ELSE 0 END) as succeeded,
         SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) as failed,
         AVG(CASE WHEN t.status = 'succeeded' THEN t.latency_ms END) as avg_latency_ms,
         MAX(t.created_at) as last_run_at
       FROM tasks t
       LEFT JOIN providers p ON p.id = t.provider_id AND p.user_id = t.user_id
       LEFT JOIN models m ON m.id = t.model_id AND m.user_id = t.user_id
       WHERE ${where.join(' AND ')}
       GROUP BY t.provider_id, COALESCE(p.name, t.provider_name), t.api_format,
                t.model_id, COALESCE(m.display_name, m.model_id, t.model_name), t.kind
       ORDER BY last_run_at DESC`,
    )
    .all(...args) as StatsRow[]
  return rows.map((r) => ({
    ...r,
    success_rate: r.total ? r.succeeded / r.total : 0,
    avg_latency_ms: r.avg_latency_ms != null ? Math.round(r.avg_latency_ms) : null,
  }))
})
