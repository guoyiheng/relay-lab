/**
 * 离线代理 · 抓取转 base64（无状态）。
 *
 * 离线要求图片结果以 base64 存本机（IndexedDB）。上游返回的图片若是 http URL（非
 * b64_json），浏览器跨域直接 fetch 常被 CORS 拦；故经本端点由服务端抓取并转 data URL
 * 返回。视频不走此路（体积大，仍存远端 URL）。免鉴权 → SSRF 校验；限大小防滥用。
 */
import { assertSafeUpstreamUrl } from '~~/server/utils/proxy-guard'
import { readResponseBytes } from '~~/server/utils/remote-fetch'
import { assertBodySize } from '~~/server/utils/request-security'

const MAX_BYTES = 25 * 1024 * 1024  // 25MB：图片足够，防止大文件塞爆 IndexedDB

export default defineEventHandler(async (event) => {
  const body = await readBody<{ url?: string }>(event)
  assertBodySize(body, 16 * 1024)
  const rawUrl = (body?.url || '').trim()
  if (rawUrl.length > 4096) throw createError({ statusCode: 400, statusMessage: '资源 URL 过长' })
  const url = assertSafeUpstreamUrl(rawUrl, { allowHttp: true })

  let resp: Response
  try {
    resp = await fetch(url, { redirect: 'error' })
  } catch (err: any) {
    throw createError({ statusCode: 502, statusMessage: `抓取失败：${err?.message || ''}` })
  }
  if (!resp.ok) throw createError({ statusCode: 502, statusMessage: `抓取失败：HTTP ${resp.status}` })

  const mime = resp.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream'
  if (!mime.startsWith('image/')) throw createError({ statusCode: 415, statusMessage: '仅允许抓取图片资源' })
  const buf = await readResponseBytes(resp, MAX_BYTES)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < buf.length; i += chunkSize) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunkSize))
  }
  const base64 = btoa(binary)
  return { dataUrl: `data:${mime};base64,${base64}`, mime, size: buf.byteLength }
})
