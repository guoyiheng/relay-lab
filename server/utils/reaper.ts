import { useDb, type TaskRecord, type ModelKind } from './db'

// ─────────────────────────────────────────────────────────────────────────────
// 僵尸任务惰性回收（lazy reaper）。
//
// 超时判断本在后台执行链路内部（taskrunner 的进程内轮询 / 队列消费者）主动写
// failed。但若后台执行从未启动或中途死掉（dev 发队列消息无人消费、生产消息进
// DLQ、Worker 崩溃、waitUntil 被回收…），就没人写终态，DB 里的 running 会永久
// 存在，前端一直转圈。
//
// 这里补一道与执行链路解耦的时间兜底：任何一次读取任务时，对「running/pending
// 且最后更新时间已超过该 kind 的 maxMs + 宽限」的行，惰性 UPDATE 成 failed。
// 只要前端还在轮询（或用户刷新），僵尸任务就会在下一次读取时被判失败、转终态，
// 前端随即停轮询。软失败，保留行与快照，符合项目「软删/快照」风格。
// ─────────────────────────────────────────────────────────────────────────────

// 与 taskrunner / adapters 的后台超时保持一致：视频 10min，其余 5min。
const IMAGE_MAX_MS = 5 * 60 * 1000
const VIDEO_MAX_MS = 10 * 60 * 1000
// 宽限：后台超时写 failed 本身也要一次往返/入队延迟，给足缓冲再由 reaper 兜底，
// 避免和后台链路抢着写、把「马上就要正常失败」的任务提前判死。
const REAP_GRACE_MS = 60 * 1000

function maxMsFor(kind: ModelKind): number {
  return kind === 'video' ? VIDEO_MAX_MS : IMAGE_MAX_MS
}

// 判断一行是否已是僵尸（进行中且超过 maxMs+宽限）。
export function isStaleRunning(row: Pick<TaskRecord, 'status' | 'kind' | 'created_at'> & { updated_at?: number }, now: number): boolean {
  if (row.status !== 'running' && row.status !== 'pending') return false
  // 手动查询确认上游仍运行后会刷新 updated_at，不能立即按创建时间再次判失败。
  return now - Math.max(row.created_at, row.updated_at || 0) > maxMsFor(row.kind as ModelKind) + REAP_GRACE_MS
}

// 惰性回收一批任务里的僵尸行：写 DB failed，并「就地」把传入行对象的状态字段
// 改成失败态，让调用方直接序列化返回、无需二次查询。返回被回收的 id 列表。
// 写库失败不抛（回收是兜底，不应阻断读取）；仅在确有僵尸行时才发 UPDATE。
export async function reapStaleTasks<T extends Pick<TaskRecord, 'id' | 'status' | 'kind' | 'created_at' | 'error_message' | 'finished_at' | 'updated_at'>>(
  rows: T[],
  userId: number,
  now = Date.now(),
): Promise<number[]> {
  const stale = rows.filter((r) => isStaleRunning(r, now))
  if (!stale.length) return []
  const ids = stale.map((r) => r.id)
  const msg = '执行超时：任务未在预期时间内回写结果（后台执行可能已中断）'
  let reapedIds: number[]
  try {
    const db = useDb()
    const ph = ids.map(() => '?').join(',')
    const reaped = await db.prepare(
      `UPDATE tasks SET status = 'failed', error_message = ?, updated_at = ?, finished_at = ?
       WHERE user_id = ? AND id IN (${ph}) AND status IN ('running','pending') AND deleted_at IS NULL
         AND MAX(created_at, updated_at) < ? - CASE WHEN kind = 'video' THEN ? ELSE ? END
       RETURNING id`,
    ).all(msg, now, now, userId, ...ids, now, VIDEO_MAX_MS + REAP_GRACE_MS, IMAGE_MAX_MS + REAP_GRACE_MS) as { id: number }[]
    reapedIds = reaped.map((r) => r.id)
  } catch (err) {
    console.error('[reaper] 回收僵尸任务失败:', err)
    return []
  }
  // 就地改写传入行，调用方序列化即反映失败态（省一次回查）。
  for (const r of stale) {
    if (!reapedIds.includes(r.id)) continue
    r.status = 'failed' as TaskRecord['status']
    if (!r.error_message) r.error_message = msg
    r.finished_at = now
    r.updated_at = now
  }
  return reapedIds
}
