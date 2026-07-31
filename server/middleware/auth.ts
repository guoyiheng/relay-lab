import { appendHeader } from 'h3'
import { getCurrentUser, getSessionToken, setAuthCacheCookie, setSessionCookie, touchSession } from '~~/server/utils/auth'

export default defineEventHandler(async (event) => {
  const url = event.node.req.url || ''
  if (!url.startsWith('/api/')) return
  if (url.startsWith('/api/auth/')) return
  // 离线代理没有服务端 session，由代理安全中间件单独执行 Origin、限速和请求约束。
  if (url.startsWith('/api/proxy/')) return
  const authStartedAt = performance.now()
  const user = await getCurrentUser(event)
  if (!user) {
    throw createError({ statusCode: 401, statusMessage: '未登录' })
  }
  // Sliding expiry: each authenticated request resets the 30-day timer
  // (throttled to once per 24h inside touchSession to avoid extra writes).
  const token = getSessionToken(event)
  const expiresAt = Number(event.context.sessionExpiresAt)
  let sessionRefreshed = false
  if (token && expiresAt) {
    const newExpiry = await touchSession(token, expiresAt)
    if (newExpiry) {
      sessionRefreshed = true
      setSessionCookie(event, token, newExpiry)
      setAuthCacheCookie(event, token, user, newExpiry)
    }
  }
  event.context.user = user
  const source = event.context.authCacheHit === true ? 'signed-cache' : 'd1'
  const desc = sessionRefreshed ? `${source}+refresh` : source
  appendHeader(event, 'Server-Timing', `auth;dur=${(performance.now() - authStartedAt).toFixed(1)};desc="${desc}"`)
})
