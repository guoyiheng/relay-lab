import { getRequestURL, setResponseHeader } from 'h3'
import {
  assertJsonRequest,
  assertSameOriginRequest,
  enforceRateLimit,
  type RateLimitBindingName,
} from '~~/server/utils/request-security'

interface ProtectedRoute {
  maxBytes: number
  binding: RateLimitBindingName
  scope: string
  globalBinding: RateLimitBindingName
  globalScope: string
}

const PROXY_ROUTES: Record<string, ProtectedRoute> = {
  '/api/proxy/generate': {
    maxBytes: 32 * 1024 * 1024,
    binding: 'OFFLINE_PROXY_HEAVY_RATE_LIMITER', scope: 'proxy-heavy',
    globalBinding: 'OFFLINE_PROXY_HEAVY_GLOBAL_RATE_LIMITER', globalScope: 'proxy-heavy-global',
  },
  '/api/proxy/llm': {
    maxBytes: 512 * 1024,
    binding: 'OFFLINE_PROXY_HEAVY_RATE_LIMITER', scope: 'proxy-heavy',
    globalBinding: 'OFFLINE_PROXY_HEAVY_GLOBAL_RATE_LIMITER', globalScope: 'proxy-heavy-global',
  },
  '/api/proxy/poll': {
    maxBytes: 64 * 1024,
    binding: 'OFFLINE_PROXY_POLL_RATE_LIMITER', scope: 'proxy-poll',
    globalBinding: 'OFFLINE_PROXY_POLL_GLOBAL_RATE_LIMITER', globalScope: 'proxy-poll-global',
  },
  '/api/proxy/fetch': {
    maxBytes: 16 * 1024,
    binding: 'OFFLINE_PROXY_FETCH_RATE_LIMITER', scope: 'proxy-fetch',
    globalBinding: 'OFFLINE_PROXY_FETCH_GLOBAL_RATE_LIMITER', globalScope: 'proxy-fetch-global',
  },
}

const AUTH_BODY_MAX = 32 * 1024

export default defineEventHandler(async (event) => {
  const pathname = getRequestURL(event).pathname
  const method = event.method.toUpperCase()
  const proxy = PROXY_ROUTES[pathname]

  if (proxy) {
    if (method !== 'POST') throw createError({ statusCode: 405, statusMessage: 'Method Not Allowed' })
    assertSameOriginRequest(event)
    assertJsonRequest(event, proxy.maxBytes)
    await enforceRateLimit(event, proxy.binding, proxy.scope)
    await enforceRateLimit(event, proxy.globalBinding, proxy.globalScope, { global: true })
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return
  }

  if (pathname.startsWith('/api/proxy/')) {
    throw createError({ statusCode: 404, statusMessage: '代理端点不存在' })
  }

  if (pathname.startsWith('/api/auth/') && ['POST', 'PATCH', 'DELETE'].includes(method)) {
    assertSameOriginRequest(event)
    if (pathname !== '/api/auth/logout') assertJsonRequest(event, AUTH_BODY_MAX)
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    await enforceRateLimit(event, 'AUTH_LOGIN_RATE_LIMITER', 'auth-login')
    await enforceRateLimit(event, 'AUTH_PUBLIC_GLOBAL_RATE_LIMITER', 'auth-public-global', { global: true })
    return
  }

  if (
    (method === 'POST' && (pathname === '/api/auth/register/request' || pathname === '/api/auth/register/verify'))
    || (method === 'GET' && pathname === '/api/auth/register/config')
  ) {
    await enforceRateLimit(event, 'AUTH_PUBLIC_RATE_LIMITER', pathname)
    await enforceRateLimit(event, 'AUTH_PUBLIC_GLOBAL_RATE_LIMITER', 'auth-public-global', { global: true })
  }
})
