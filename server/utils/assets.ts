/// <reference types="@cloudflare/workers-types" />
import crypto from 'node:crypto'
import { useDb, type AssetKind, type AssetSource, type AssetRecord } from './db'
import { uploadKey, extFor, putObject, r2PublicUrl } from './storage'

// ─────────────────────────────────────────────────────────────────────────────
// 素材写入的唯一入口（DRY）。本地上传、站外 URL 导入、生成结果转存都走这里，
// 统一：sha256 内容去重 → 命中则复用行；未命中则 putObject + INSERT assets 行。
//   · putAssetFromBytes  已有字节（表单/导入/结果 fetch 后）→ 建/复用 asset
//   · registerGeneratedAsset  结果已在 R2（taskrunner 转存后）→ 幂等登记 generated 行
// 「素材是否有 id」= assets 表是否有行；引用一律用 asset id（含生成结果复用为参考）。
// ─────────────────────────────────────────────────────────────────────────────

function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function newAssetId(): string {
  return `as_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`
}

export interface PutAssetInput {
  userId: number
  storageNamespace: string
  bytes: Uint8Array
  kind: AssetKind
  mime?: string | null
  filename?: string | null
  width?: number | null
  height?: number | null
  source?: AssetSource        // 默认 local
  taskId?: number | null      // source=generated 时来源任务
  resultIdx?: number | null
}

export interface PutAssetResult {
  id: string
  kind: AssetKind
  filename: string | null
  mime: string | null
  size: number
  width: number | null
  height: number | null
  r2_key: string
  public_url: string
  deduped: boolean
}

// 建/复用一个素材：按 (sha256, kind) 去重。命中已有行则直接复用（字节已在 R2）。
export async function putAssetFromBytes(input: PutAssetInput): Promise<PutAssetResult> {
  const { bytes, kind } = input
  const mime = input.mime ?? null
  const filename = input.filename ?? null
  const source: AssetSource = input.source ?? 'local'
  const sha = sha256Hex(bytes)
  const db = useDb()

  const existing = await db
    .prepare('SELECT * FROM assets WHERE user_id = ? AND sha256 = ? AND kind = ? LIMIT 1')
    .get(input.userId, sha, kind) as AssetRecord | null
  if (existing) {
    // Uploading identical bytes again is a fresh use: restart the seven-day
    // window for non-xxn users. The administrator remains permanently exempt.
    const now = Date.now()
    await db.prepare(`
      UPDATE assets
      SET expires_at = CASE
        WHEN EXISTS (SELECT 1 FROM users u WHERE u.id = assets.user_id AND u.username <> 'xxn')
          THEN ?
        ELSE NULL
      END
      WHERE id = ? AND user_id = ?
    `).run(now + 7 * 24 * 60 * 60 * 1000, existing.id, input.userId)
    return {
      id: existing.id,
      kind: existing.kind,
      filename: existing.filename,
      mime: existing.mime,
      size: existing.size ?? bytes.byteLength,
      width: existing.width,
      height: existing.height,
      r2_key: existing.r2_key,
      public_url: r2PublicUrl(existing.r2_key),
      deduped: true,
    }
  }

  const id = newAssetId()
  const now = Date.now()
  const r2_key = uploadKey(input.storageNamespace, id, extFor(mime, filename))
  await putObject(r2_key, bytes, { contentType: mime })
  await db.prepare(
    `INSERT INTO assets (id, user_id, source, kind, filename, mime, size, width, height, sha256, r2_key, task_id, result_idx, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.userId, source, kind, filename, mime, bytes.byteLength,
    input.width ?? null, input.height ?? null, sha, r2_key,
    input.taskId ?? null, input.resultIdx ?? null, now,
  )
  return {
    id, kind, filename, mime, size: bytes.byteLength,
    width: input.width ?? null, height: input.height ?? null,
    r2_key, public_url: r2PublicUrl(r2_key), deduped: false,
  }
}

// 结果已转存到 R2（results/{taskId}/{idx}.ext，见 taskrunner.persistResultToR2），
// 为其幂等登记一行 generated asset，使其可被当作参考素材（用 asset id 引用）。
// 幂等键 (task_id, result_idx)：INSERT OR IGNORE，重复登记不报错。r2Key 与 tasks.result_urls
// 指向同一对象，不重复存储。非我方 R2 结果（超大保留远端的上游 URL）r2Key 传 null 跳过。
export async function registerGeneratedAsset(
  taskId: number,
  resultIdx: number,
  r2Key: string | null,
  kind: AssetKind,
  mime?: string | null,
): Promise<void> {
  if (!r2Key) return
  const db = useDb()
  const id = newAssetId()
  await db.prepare(
    `INSERT OR IGNORE INTO assets
       (id, user_id, source, kind, filename, mime, size, width, height, sha256, r2_key, task_id, result_idx, created_at)
     SELECT ?, t.user_id, 'generated', ?, NULL, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?
     FROM tasks t WHERE t.id = ?`,
  ).run(id, kind, mime ?? null, r2Key, taskId, resultIdx, Date.now(), taskId)
}
