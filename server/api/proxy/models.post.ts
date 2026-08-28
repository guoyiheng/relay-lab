/**
 * 读取上游 OpenAI 兼容模型列表。
 *
 * 模型管理页需要在不暴露浏览器跨域细节的情况下探测平台配置，因此复用离线代理的
 * 无状态转发方式。API Key 只在本次请求内存中使用，不落库。
 */
import type { ApiFormat } from '~~/types/api'
import { assertSafeUpstreamUrl } from '~~/server/utils/proxy-guard'
import { assertBodySize } from '~~/server/utils/request-security'
import { readResponseBytes } from '~~/server/utils/remote-fetch'

interface Body {
  baseUrl?: string
  apiKey?: string
  apiFormat?: ApiFormat
}

interface ListedModel {
  id: string
  name?: string
}

function modelsUrl(rawBaseUrl: string, apiFormat?: ApiFormat): string {
  const base = new URL(rawBaseUrl)
  // full-url 平台保存的是具体生成端点，先退回 API 根路径再补 /models。
  if (apiFormat === 'full-url' && /\/models\/?$/i.test(base.pathname)) return base.toString()
  if (apiFormat === 'full-url') {
    base.pathname = base.pathname.replace(
      /\/(?:chat\/completions|images\/(?:generations|edits)|videos\/generations)\/?$/i,
      '',
    )
    base.search = ''
    base.hash = ''
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/models`
  return base.toString()
}

function normalizeModels(payload: unknown): ListedModel[] {
  const source = Array.isArray(payload)
    ? payload
    : (payload && typeof payload === 'object'
        ? ((payload as any).data || (payload as any).models || (payload as any).items || [])
        : [])
  if (!Array.isArray(source)) return []
  const seen = new Set<string>()
  const result: ListedModel[] = []
  for (const item of source) {
    const id = typeof item === 'string' ? item.trim() : String(item?.id || item?.model || '').trim()
    if (!id || id.length > 512 || seen.has(id)) continue
    seen.add(id)
    const name = typeof item === 'object' && item && typeof item.name === 'string' ? item.name.trim() : undefined
    result.push(name && name !== id ? { id, name: name.slice(0, 512) } : { id })
  }
  return result.slice(0, 1000)
}

export default defineEventHandler(async (event) => {
  const body = await readBody<Body>(event)
  assertBodySize(body, 32 * 1024)
  const rawBaseUrl = String(body?.baseUrl || '').trim()
  const apiKey = String(body?.apiKey || '').trim()
  if (!rawBaseUrl) throw createError({ statusCode: 400, statusMessage: '缺少 Base URL' })
  if (!apiKey) throw createError({ statusCode: 400, statusMessage: '缺少 API Key' })
  if (rawBaseUrl.length > 4096 || apiKey.length > 16_384) {
    throw createError({ statusCode: 400, statusMessage: '平台配置过长' })
  }

  const safeBaseUrl = assertSafeUpstreamUrl(rawBaseUrl)
  const url = assertSafeUpstreamUrl(modelsUrl(safeBaseUrl, body?.apiFormat))
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
    })
  } catch (err: any) {
    throw createError({ statusCode: 502, statusMessage: `获取模型失败：${err?.message || '网络错误'}` })
  }

  let payload: unknown = null
  try {
    const bytes = await readResponseBytes(response, 2 * 1024 * 1024)
    payload = JSON.parse(new TextDecoder().decode(bytes))
  } catch { /* fall through to a useful HTTP error or an empty list */ }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && typeof (payload as any).error?.message === 'string'
      ? (payload as any).error.message
      : `上游返回 HTTP ${response.status}`
    throw createError({ statusCode: 502, statusMessage: `获取模型失败：${String(message).slice(0, 300)}` })
  }
  return { models: normalizeModels(payload) }
})
