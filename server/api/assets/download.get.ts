import { requireUserId } from '~~/server/utils/auth'
import { userOwnsAssetUrl } from '~~/server/utils/asset-access'
import { useBucket } from '~~/server/utils/db'
import { parsePublicHttpUrl } from '~~/server/utils/remote-fetch'
import { keyFromUrl } from '~~/server/utils/storage'

// 仅代理当前用户任务结果或素材库对象，避免把接口变成任意 URL/内网下载代理。
export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const query = getQuery(event)
  const url = String(query.url || '')
  const filename = String(query.filename || 'download').slice(0, 240)
  const target = parsePublicHttpUrl(url)
  const targetUrl = target.toString()

  if (!await userOwnsAssetUrl(userId, targetUrl)) {
    throw createError({ statusCode: 403, statusMessage: '无权下载该素材' })
  }

  let body: ReadableStream
  let mime: string
  let length: number | null = null
  const r2Key = keyFromUrl(targetUrl)

  if (r2Key) {
    // 自有素材直接读 R2 binding。不要让 Worker 再通过公开 R2 域名回源：
    // 那会多一次 DNS/TLS/HTTP 跳转，并且同一 Cloudflare zone 内的公网自回源可能直接失败。
    const object = await useBucket().get(r2Key)
    if (!object?.body) {
      throw createError({ statusCode: 502, statusMessage: '素材对象不存在' })
    }
    body = object.body
    mime = object.httpMetadata?.contentType || 'application/octet-stream'
    length = object.size
  } else {
    let upstream: Response
    try {
      upstream = await fetch(targetUrl, { redirect: 'error' })
    } catch {
      throw createError({ statusCode: 502, statusMessage: '拉取失败' })
    }
    if (!upstream.ok || !upstream.body) {
      throw createError({ statusCode: 502, statusMessage: `上游 ${upstream.status}` })
    }
    body = upstream.body
    mime = upstream.headers.get('content-type') || 'application/octet-stream'
    const declaredLength = Number(upstream.headers.get('content-length'))
    if (Number.isSafeInteger(declaredLength) && declaredLength >= 0) length = declaredLength
  }

  setHeader(event, 'Content-Type', mime)
  const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
  setHeader(event, 'Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
  if (length !== null) setHeader(event, 'Content-Length', length)
  setHeader(event, 'Cache-Control', 'no-store')
  return body
})
