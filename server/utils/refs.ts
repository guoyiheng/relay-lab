import {
  useDb,
  type AssetKind,
} from './db'
import { r2PublicUrl } from './storage'
import type { TaskRefAsset } from '~~/types/api'

type JoinedTaskAssetRow = {
  task_id: number
  kind: AssetKind
  idx: number
  asset_id: string
  filename: string | null
  mime: string | null
  size: number | null
  width: number | null
  height: number | null
  r2_key: string
}

type RefsByKind = { image: TaskRefAsset[]; video: TaskRefAsset[]; audio: TaskRefAsset[] }

function emptyRefs(): RefsByKind {
  return { image: [], video: [], audio: [] }
}

export async function loadTaskRefs(taskIds: number[], userId: number): Promise<Map<number, RefsByKind>> {
  const map = new Map<number, RefsByKind>()
  for (const id of taskIds) map.set(id, emptyRefs())
  if (!taskIds.length) return map
  const placeholders = taskIds.map(() => '?').join(',')
  // The old implementation first loaded task_assets and then loaded assets by
  // id, producing two serialized D1 network round trips. A single indexed JOIN
  // returns the same metadata in one trip and is especially important when the
  // Worker is reached from mainland China.
  const rows = await useDb()
    .prepare(`
      SELECT ta.task_id, ta.kind, ta.idx, ta.asset_id,
             a.filename, a.mime, a.size, a.width, a.height, a.r2_key
      FROM task_assets ta
      JOIN assets a ON a.id = ta.asset_id AND a.user_id = ta.user_id
      WHERE ta.user_id = ? AND ta.task_id IN (${placeholders})
      ORDER BY ta.task_id, ta.kind, ta.idx
    `)
    .all(userId, ...taskIds) as JoinedTaskAssetRow[]

  for (const row of rows) {
    const bucket = map.get(row.task_id) || emptyRefs()
    bucket[row.kind].push({
      asset_id: row.asset_id,
      filename: row.filename,
      public_url: r2PublicUrl(row.r2_key),
      mime: row.mime,
      size: row.size,
      width: row.width,
      height: row.height,
    })
    map.set(row.task_id, bucket)
  }
  return map
}
