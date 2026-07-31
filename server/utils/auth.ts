import crypto from 'node:crypto'
import { getCookie, setCookie, deleteCookie, type H3Event } from 'h3'
import { cfEnv, useDb } from './db'

export const SESSION_COOKIE = 'seedance_session'
export const AUTH_CACHE_COOKIE = 'relay_auth_cache'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000  // 30 days
// Only rewrite the DB / cookie if more than this much time would be added.
// Avoids a write on every request — 1 day is precise enough for a 30-day window.
const SESSION_REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000
// A valid signed cache lets the high-frequency API calls following /auth/me
// skip the D1 session JOIN. Revocation can lag by at most this short window;
// logout clears both cookies immediately in the normal browser flow.
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000

export interface AuthedUser {
  id: number
  username: string
  avatar: string | null
  nickname: string | null
}

interface SessionUserRow extends AuthedUser {
  expires_at: number
}

interface AuthCachePayload {
  v: 1
  sid: string
  uid: number
  username: string
  nickname: string | null
  sessionExpiresAt: number
  expiresAt: number
}

function authCacheSecret(): string | null {
  try {
    const value = String(cfEnv().SESSION_CACHE_SECRET || '')
    return value.length >= 32 ? value : null
  } catch {
    return null
  }
}

function sessionFingerprint(token: string): string {
  return crypto.createHash('sha256').update(token).digest('base64url').slice(0, 22)
}

function signAuthPayload(encodedPayload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`relay-auth-cache-v1.${encodedPayload}`).digest('base64url')
}

function encodeAuthCache(token: string, user: AuthedUser, sessionExpiresAt: number): { value: string; expiresAt: number } | null {
  const secret = authCacheSecret()
  if (!secret) return null
  const now = Date.now()
  const expiresAt = Math.min(now + AUTH_CACHE_TTL_MS, sessionExpiresAt)
  if (expiresAt <= now) return null
  const payload: AuthCachePayload = {
    v: 1,
    sid: sessionFingerprint(token),
    uid: user.id,
    username: user.username,
    // Avatar is intentionally excluded: profile avatars may be base64 and can
    // exceed browser cookie limits. /api/auth/me always performs the fresh JOIN
    // and returns the complete profile; guarded business APIs only need user id.
    nickname: user.nickname,
    sessionExpiresAt,
    expiresAt,
  }
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return { value: `${encodedPayload}.${signAuthPayload(encodedPayload, secret)}`, expiresAt }
}

function timingSafeTextEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function readAuthCache(event: H3Event, token: string): { user: AuthedUser; sessionExpiresAt: number } | null {
  const secret = authCacheSecret()
  const raw = getCookie(event, AUTH_CACHE_COOKIE)
  if (!secret || !raw) return null
  const splitAt = raw.lastIndexOf('.')
  if (splitAt <= 0) return null
  const encodedPayload = raw.slice(0, splitAt)
  const signature = raw.slice(splitAt + 1)
  if (!timingSafeTextEqual(signature, signAuthPayload(encodedPayload, secret))) return null
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Partial<AuthCachePayload>
    const now = Date.now()
    if (payload.v !== 1 || !Number.isInteger(payload.uid) || Number(payload.uid) <= 0) return null
    if (typeof payload.username !== 'string' || !payload.username) return null
    if (payload.sid !== sessionFingerprint(token)) return null
    if (!Number.isFinite(payload.expiresAt) || Number(payload.expiresAt) <= now) return null
    if (!Number.isFinite(payload.sessionExpiresAt) || Number(payload.sessionExpiresAt) <= now) return null
    return {
      user: {
        id: Number(payload.uid),
        username: payload.username,
        avatar: null,
        nickname: typeof payload.nickname === 'string' ? payload.nickname : null,
      },
      sessionExpiresAt: Number(payload.sessionExpiresAt),
    }
  } catch {
    return null
  }
}

export async function createSession(userId: number): Promise<{ token: string; expiresAt: number }> {
  const token = crypto.randomBytes(32).toString('hex')
  const now = Date.now()
  const expiresAt = now + SESSION_TTL_MS
  await useDb()
    .prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(token, userId, now, expiresAt)
  return { token, expiresAt }
}

export async function destroySession(token: string): Promise<void> {
  await useDb().prepare(`DELETE FROM sessions WHERE token = ?`).run(token)
}

export async function loadSessionUser(token: string): Promise<SessionUserRow | null> {
  // Authentication used to issue two sequential D1 reads (session, then user).
  // Since the Worker normally runs at the request edge while the D1 primary is
  // elsewhere, network round trips dominate the sub-millisecond SQL work. Keep
  // the lookup in one indexed JOIN so every authenticated request pays one D1
  // hop instead of two.
  const row = await useDb().prepare(`
    SELECT u.id, u.username, u.avatar, u.nickname, s.expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
    LIMIT 1
  `).get(token) as SessionUserRow | null
  if (!row) return null
  if (row.expires_at < Date.now()) {
    await destroySession(token)
    return null
  }
  return row
}

// Sliding window: any authenticated activity within the TTL pushes the expiry
// to `now + SESSION_TTL_MS`. The caller already loaded expiresAt as part of the
// authentication JOIN, so this function must not re-read the session row.
// Returning null means no DB write and no Set-Cookie header are needed.
export async function touchSession(token: string, expiresAt: number): Promise<number | null> {
  const now = Date.now()
  if (expiresAt < now) return null
  const newExpiry = now + SESSION_TTL_MS
  if (newExpiry - expiresAt < SESSION_REFRESH_THRESHOLD_MS) return null
  const result = await useDb().prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`).run(newExpiry, token)
  // A signed cache may outlive an out-of-band session revocation for at most
  // AUTH_CACHE_TTL_MS. Never mint a fresh cache when the backing session was
  // already deleted, otherwise a busy revoked client could extend itself.
  return result.changes > 0 ? newExpiry : null
}

export function setSessionCookie(event: H3Event, token: string, expiresAt: number) {
  setCookie(event, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !import.meta.dev,
    path: '/',
    expires: new Date(expiresAt),
  })
}

export function setAuthCacheCookie(event: H3Event, token: string, user: AuthedUser, sessionExpiresAt: number) {
  const encoded = encodeAuthCache(token, user, sessionExpiresAt)
  if (!encoded) return
  setCookie(event, AUTH_CACHE_COOKIE, encoded.value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !import.meta.dev,
    path: '/',
    expires: new Date(encoded.expiresAt),
  })
}

export function clearAuthCacheCookie(event: H3Event) {
  deleteCookie(event, AUTH_CACHE_COOKIE, { path: '/' })
}

export function clearSessionCookie(event: H3Event) {
  deleteCookie(event, SESSION_COOKIE, { path: '/' })
  clearAuthCacheCookie(event)
}

export function getSessionToken(event: H3Event): string | undefined {
  return getCookie(event, SESSION_COOKIE)
}

export async function getCurrentUser(event: H3Event, options?: { fresh?: boolean }): Promise<AuthedUser | null> {
  // Reuse middleware authentication when a route calls getCurrentUser again.
  // This removes duplicate D1 lookups from analytics and other guarded routes.
  if (!options?.fresh) {
    const requestCached = event.context.user as AuthedUser | undefined
    if (requestCached?.id) return requestCached
  }

  const token = getSessionToken(event)
  if (!token) return null

  if (!options?.fresh) {
    const signed = readAuthCache(event, token)
    if (signed) {
      event.context.user = signed.user
      event.context.sessionExpiresAt = signed.sessionExpiresAt
      event.context.authCacheHit = true
      return signed.user
    }
  }

  const row = await loadSessionUser(token)
  if (!row) {
    clearAuthCacheCookie(event)
    return null
  }

  const user: AuthedUser = {
    id: row.id,
    username: row.username,
    avatar: row.avatar,
    nickname: row.nickname,
  }
  event.context.user = user
  event.context.sessionExpiresAt = row.expires_at
  event.context.authCacheHit = false
  setAuthCacheCookie(event, token, user, row.expires_at)
  return user
}

export function requireUserId(event: H3Event): number {
  const id = Number((event.context.user as AuthedUser | undefined)?.id)
  if (!id) throw createError({ statusCode: 401, statusMessage: '未登录' })
  return id
}

export async function requireUserStorageNamespace(event: H3Event): Promise<{ userId: number; storageNamespace: string }> {
  const userId = requireUserId(event)
  const row = await useDb().prepare('SELECT storage_namespace FROM users WHERE id = ?').get(userId) as { storage_namespace: string | null } | null
  if (!row?.storage_namespace) throw createError({ statusCode: 500, statusMessage: '用户存储空间未初始化' })
  return { userId, storageNamespace: row.storage_namespace }
}
