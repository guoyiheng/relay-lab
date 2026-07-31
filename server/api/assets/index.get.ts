import { useDb, type AssetKind } from '~~/server/utils/db'
import { r2PublicUrl } from '~~/server/utils/storage'
import { requireUserId } from '~~/server/utils/auth'

export interface AssetItem {
  source: 'upload' | 'generated'   // 'upload' 对外沿用旧名，实际是本地 local 素材
  id: string                       // asset id（本地与生成都是真 id，可直接作参考引用）
  kind: AssetKind
  url: string
  filename: string | null
  mime: string | null
  size: number | null
  width: number | null
  height: number | null
  created_at: number
  meta?: {
    task_id?: number
    provider_name?: string
    model_name?: string
    prompt?: string
  }
}

interface AssetRow {
  id: string
  source: 'local' | 'generated'
  kind: AssetKind
  filename: string | null
  mime: string | null
  size: number | null
  width: number | null
  height: number | null
  r2_key: string
  task_id: number | null
  created_at: number
  provider_name: string | null
  model_name: string | null
  prompt: string | null
}

// 素材库：单表 assets 查询（本地上传 + 生成结果统一）。生成素材 LEFT JOIN tasks 取展示元数据；
// 只列来源任务未被软删的生成素材。id 即 asset id，可直接拖拽/@ 作为参考（无需重新导入）。
export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const query = getQuery(event)
  const wantedKind = query.kind ? String(query.kind) as AssetKind : null
  const db = useDb()

  const where: string[] = ['a.user_id = ?', '(a.source = ? OR (a.source = ? AND t.deleted_at IS NULL AND t.status = ? AND t.assets_cleaned_at IS NULL))']
  const args: unknown[] = [userId, 'local', 'generated', 'succeeded']
  if (wantedKind) { where.push('a.kind = ?'); args.push(wantedKind) }

  const rows = await db.prepare(`
    SELECT a.id, a.source, a.kind, a.filename, a.mime, a.size, a.width, a.height,
           a.r2_key, a.task_id, a.created_at,
           t.provider_name, t.model_name, t.prompt
    FROM assets a
    LEFT JOIN tasks t ON t.id = a.task_id AND t.user_id = a.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY a.created_at DESC
  `).all(...args) as AssetRow[]

  return rows.map((a): AssetItem => ({
    source: a.source === 'generated' ? 'generated' : 'upload',
    id: a.id,
    kind: a.kind,
    url: r2PublicUrl(a.r2_key),
    filename: a.filename,
    mime: a.mime,
    size: a.size,
    width: a.width,
    height: a.height,
    created_at: a.created_at,
    meta: a.source === 'generated'
      ? { task_id: a.task_id ?? undefined, provider_name: a.provider_name ?? undefined, model_name: a.model_name ?? undefined, prompt: a.prompt ?? undefined }
      : undefined,
  }))
})
