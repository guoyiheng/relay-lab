import {
  getRequestHeader,
  getRequestIP,
  getRequestURL,
  setResponseHeader,
  type H3Event,
} from 'h3'
import { cfEnv } from './db'

export type RateLimitBindingName =
  | 'OFFLINE_PROXY_HEAVY_RATE_LIMITER'
  | 'OFFLINE_PROXY_POLL_RATE_LIMITER'
  | 'OFFLINE_PROXY_FETCH_RATE_LIMITER'
  | 'AUTH_LOGIN_RATE_LIMITER'
  | 'AUTH_PUBLIC_RATE_LIMITER'
  | 'OFFLINE_PROXY_HEAVY_GLOBAL_RATE_LIMITER'
  | 'OFFLINE_PROXY_POLL_GLOBAL_RATE_LIMITER'
  | 'OFFLINE_PROXY_FETCH_GLOBAL_RATE_LIMITER'
  | 'AUTH_PUBLIC_GLOBAL_RATE_LIMITER'

function normalizedOrigin(raw: string): string | null {
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

export function assertSameOriginRequest(event: H3Event): void {
  const origin = normalizedOrigin(getRequestHeader(event, 'origin') || '')
  const configured = normalizedOrigin(String(cfEnv().PUBLIC_APP_URL || ''))
  const allowed = new Set<string>()
  if (configured) allowed.add(configured)
  if (import.meta.dev) allowed.add(getRequestURL(event).origin)

  if (!allowed.size) {
    throw createError({ statusCode: 503, statusMessage: 'PUBLIC_APP_URL 未配置，已拒绝公开端点请求' })
  }
  if (!origin || !allowed.has(origin)) {
    throw createError({ statusCode: 403, statusMessage: '请求来源不受信任' })
  }

  const fetchSite = (getRequestHeader(event, 'sec-fetch-site') || '').toLowerCase()
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw createError({ statusCode: 403, statusMessage: '仅允许同源请求' })
  }
}

export function assertJsonRequest(event: H3Event, maxBytes: number): void {
  const contentType = (getRequestHeader(event, 'content-type') || '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    throw createError({ statusCode: 415, statusMessage: '仅接受 application/json' })
  }
  const declared = Number(getRequestHeader(event, 'content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw createError({ statusCode: 413, statusMessage: '请求体过大' })
  }
}

export function assertBodySize(body: unknown, maxBytes: number): void {
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(body)
  } catch {
    throw createError({ statusCode: 400, statusMessage: '请求体不是有效 JSON' })
  }
  if (encoded === undefined) throw createError({ statusCode: 400, statusMessage: '请求体不能为空' })
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) {
    throw createError({ statusCode: 413, statusMessage: '请求体过大' })
  }
}

function clientRateLimitKey(event: H3Event): string {
  const edgeIp = getRequestHeader(event, 'cf-connecting-ip')?.trim()
  if (edgeIp) return edgeIp
  if (import.meta.dev) return getRequestIP(event, { xForwardedFor: true }) || 'local-dev'
  return 'missing-edge-ip'
}

function getRateLimiter(name: RateLimitBindingName): RateLimit | null {
  const binding = cfEnv()[name]
  if (binding && typeof (binding as RateLimit).limit === 'function') return binding as RateLimit
  return null
}

export async function enforceRateLimit(
  event: H3Event,
  bindingName: RateLimitBindingName,
  scope: string,
  options: { global?: boolean } = {},
): Promise<void> {
  const limiter = getRateLimiter(bindingName)
  if (!limiter) {
    if (import.meta.dev) return
    throw createError({ statusCode: 503, statusMessage: '请求限速尚未配置' })
  }

  let success = false
  try {
    const key = options.global ? scope : `${scope}:${clientRateLimitKey(event)}`
    const outcome = await limiter.limit({ key })
    success = outcome.success
  } catch (error) {
    console.error(JSON.stringify({ message: 'rate limiter failed', binding: bindingName, scope, error: String(error) }))
    if (import.meta.dev) return
    throw createError({ statusCode: 503, statusMessage: '请求限速服务暂不可用' })
  }

  if (!success) {
    setResponseHeader(event, 'Retry-After', 60)
    console.warn(JSON.stringify({ message: 'request rate limited', binding: bindingName, scope }))
    throw createError({ statusCode: 429, statusMessage: '请求过于频繁，请稍后再试' })
  }
}
