import { readBody } from 'h3'
import { useDb, type AssetKind, type AssetRecord } from '~~/server/utils/db'
import { putAssetFromBytes } from '~~/server/utils/assets'
import { keyFromUrl, r2PublicUrl } from '~~/server/utils/storage'
import { requireUserStorageNamespace } from '~~/server/utils/auth'
import { userOwnsAssetUrl } from '~~/server/utils/asset-access'
import { parsePublicHttpUrl, readResponseBytes } from '~~/server/utils/remote-fetch'

interface Body {
  url?: string
  kind?: AssetKind
}

const MAX_BYTES: Record<AssetKind, number> = {
  image: 30 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  audio: 30 * 1024 * 1024,
}

function kindOfMime(mime: string): AssetKind | null {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return null
}

function filenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop()
    return last || null
  } catch {
    return null
  }
}

// Import a remote URL (e.g. a generated asset URL) into the local uploads
// table so it can later be used as a reference asset for new tasks.
export default defineEventHandler(async (event) => {
  const { userId, storageNamespace } = await requireUserStorageNamespace(event)
  const body = await readBody<Body>(event)
  const url = (body?.url || '').trim()
  const kindHint = (body?.kind || '').trim() as AssetKind | ''
  if (!url) throw createError({ statusCode: 400, statusMessage: '缺少 url' })
  const target = parsePublicHttpUrl(url)

  // 快路径：URL 本就是我方 R2 对象（如生成结果 assets.relay.yiheng.run/results/…）。
  // 直接按 r2_key 查已有 asset 行并复用其 id，不重新下载、不新建行——生成素材复用为
  // 参考时零重复上传。查不到（对象存在但无 assets 行）再落到下面的通用下载导入。
  const ownKey = keyFromUrl(target.toString())
  if (ownKey) {
    const existing = await useDb()
      .prepare('SELECT * FROM assets WHERE user_id = ? AND r2_key = ? LIMIT 1')
      .get(userId, ownKey) as AssetRecord | null
    if (existing) {
      return {
        id: existing.id,
        kind: existing.kind,
        filename: existing.filename,
        mime: existing.mime,
        size: existing.size,
        public_url: r2PublicUrl(existing.r2_key),
        deduped: true,
      }
    }
  }

  // 远端 URL 必须已精确出现在当前用户自己的任务结果中。既防止跨用户复用公开
  // R2 地址，也避免把该接口变成可探测任意公网/内网的 SSRF 下载器。
  if (!await userOwnsAssetUrl(userId, target.toString())) {
    throw createError({ statusCode: 403, statusMessage: '无权导入该素材' })
  }

  let resp: Response
  try {
    resp = await fetch(target.toString(), { redirect: 'error' })
  } catch (err: any) {
    throw createError({ statusCode: 502, statusMessage: `下载失败：${err?.message || ''}` })
  }
  if (!resp.ok) {
    throw createError({ statusCode: 502, statusMessage: `下载失败：HTTP ${resp.status}` })
  }
  const contentType = resp.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream'
  const guessed = kindOfMime(contentType)
  const kind = (kindHint || guessed) as AssetKind | null
  if (!kind || !['image', 'video', 'audio'].includes(kind)) {
    throw createError({ statusCode: 400, statusMessage: `无法识别 kind（content-type=${contentType}）` })
  }
  const bytes = await readResponseBytes(resp, MAX_BYTES[kind])
  const filename = filenameFromUrl(target.toString())
  // 统一走 assets 写入入口：sha256 去重（同字节已导入过则复用行），字节落 R2，source=local。
  const asset = await putAssetFromBytes({
    userId, storageNamespace,
    bytes,
    kind,
    mime: contentType,
    filename,
    source: 'local',
  })

  return {
    id: asset.id,
    kind: asset.kind,
    filename: asset.filename,
    mime: asset.mime,
    size: asset.size,
    public_url: asset.public_url,
    deduped: asset.deduped,
  }
})
