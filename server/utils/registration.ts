import crypto from 'node:crypto'
import { getRequestHeader, getRequestIP, getRequestURL, type H3Event } from 'h3'
import { cfEnv, hashPassword, useDb, type UserRecord } from './db'
import { createSession, setAuthCacheCookie, setSessionCookie } from './auth'

const VERIFY_TTL_MS = 15 * 60 * 1000
const MAX_REGISTRATIONS_PER_IP_DAY = 10
const MAX_EMAILS_PER_IP_DAY = 30

export function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(sha256(a), 'hex')
  const right = Buffer.from(sha256(b), 'hex')
  return crypto.timingSafeEqual(left, right)
}

export function inviteIsValid(value: unknown): boolean {
  const configured = String(cfEnv().REGISTRATION_INVITE_CODE ?? '').trim()
  const supplied = String(value ?? '').trim()
  return configured.length >= 8 && constantTimeEqual(supplied, configured)
}

function clientIp(event: H3Event): string {
  const cf = getRequestHeader(event, 'cf-connecting-ip')?.trim()
  if (cf) return cf
  const forwarded = getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || getRequestIP(event, { xForwardedFor: true }) || 'unknown'
}

export function ipHashForRequest(event: H3Event): string {
  const secret = String(cfEnv().AUTH_IP_HASH_SECRET ?? '')
  if (secret.length < 24) {
    throw createError({ statusCode: 503, statusMessage: '注册服务尚未完成安全配置' })
  }
  return crypto.createHmac('sha256', secret).update(clientIp(event)).digest('hex')
}

// 注册业务按中国时区统计“每天”，避免 UTC 16:00 就跨日。
export function registrationDayKey(now = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now))
}

function appBaseUrl(event: H3Event): string {
  const configured = String(cfEnv().PUBLIC_APP_URL ?? '').trim().replace(/\/+$/, '')
  return configured || getRequestURL(event).origin
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] || char))
}

async function reserveVerificationEmail(ipHash: string, now: number): Promise<void> {
  const day = registrationDayKey(now)
  const db = useDb()
  const row = await db.prepare(`
    INSERT INTO registration_email_ip_days (ip_hash, day_key, send_count, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(ip_hash, day_key) DO UPDATE SET
      send_count = send_count + 1,
      updated_at = excluded.updated_at
    WHERE registration_email_ip_days.send_count < ?
    RETURNING send_count
  `).get(ipHash, day, now, MAX_EMAILS_PER_IP_DAY) as { send_count: number } | null
  if (!row) throw createError({ statusCode: 429, statusMessage: '今日验证邮件发送次数已达上限，请明天再试' })
}

async function sendVerificationEmail(email: string, verifyUrl: string, tokenHash: string): Promise<void> {
  const env = cfEnv()
  const apiKey = String(env.RESEND_API_KEY ?? '')
  const from = String(env.RESEND_FROM ?? '')
  if (!apiKey || !from) {
    throw createError({ statusCode: 503, statusMessage: '邮件服务尚未配置' })
  }
  const safeUrl = escapeHtml(verifyUrl)
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `relay-register-${tokenHash.slice(0, 32)}`,
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: '确认注册 Relay Lab',
      html: `<div style="font-family:ui-sans-serif,system-ui;color:#14213d;line-height:1.7;max-width:560px;margin:auto;padding:32px"><h1 style="font-size:22px">确认你的邮箱</h1><p>点击下方按钮完成 Relay Lab 注册。链接将在 15 分钟后失效。</p><p style="margin:28px 0"><a href="${safeUrl}" style="display:inline-block;background:#2764ff;color:white;text-decoration:none;padding:11px 20px;border-radius:8px">确认邮箱并注册</a></p><p style="font-size:13px;color:#63708a">如果这不是你的操作，可以直接忽略本邮件。</p></div>`,
      text: `请在 15 分钟内打开以下链接完成 Relay Lab 注册：\n${verifyUrl}\n\n如果这不是你的操作，可以忽略本邮件。`,
      tags: [{ name: 'category', value: 'registration_verify' }],
    }),
  })
  if (!response.ok) {
    console.error('[registration] Resend request failed', { status: response.status })
    throw createError({ statusCode: 502, statusMessage: '验证邮件发送失败，请稍后重试' })
  }
}

export async function requestEmailRegistration(event: H3Event, input: {
  email: unknown
  password: unknown
  invite: unknown
}): Promise<void> {
  if (!inviteIsValid(input.invite)) {
    throw createError({ statusCode: 403, statusMessage: '邀请链接无效或已失效' })
  }
  const email = normalizeEmail(input.email)
  const password = String(input.password ?? '')
  if (!isValidEmail(email)) throw createError({ statusCode: 400, statusMessage: '请输入有效的邮箱地址' })
  if (password.length < 10 || password.length > 128) {
    throw createError({ statusCode: 400, statusMessage: '密码长度需为 10–128 位' })
  }

  const db = useDb()
  const existing = await db.prepare(
    'SELECT id FROM users WHERE lower(email) = ? OR lower(username) = ? LIMIT 1',
  ).get(email, email) as { id: number } | null
  if (existing) throw createError({ statusCode: 409, statusMessage: '该邮箱已注册，请直接登录' })

  const ipHash = ipHashForRequest(event)
  const day = registrationDayKey()
  const used = await db.prepare(
    'SELECT COUNT(*) AS n FROM registration_ip_slots WHERE ip_hash = ? AND day_key = ?',
  ).get(ipHash, day) as { n: number } | null
  if (Number(used?.n ?? 0) >= MAX_REGISTRATIONS_PER_IP_DAY) {
    throw createError({ statusCode: 429, statusMessage: '该网络今日注册账号数已达上限' })
  }

  const now = Date.now()
  await reserveVerificationEmail(ipHash, now)
  const token = crypto.randomBytes(32).toString('base64url')
  const tokenHash = sha256(token)
  const expiresAt = now + VERIFY_TTL_MS
  await db.prepare('DELETE FROM pending_registrations WHERE expires_at < ?').run(now)
  await db.prepare(`
    INSERT INTO pending_registrations
      (email, password_hash, token_hash, request_ip_hash, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      password_hash = excluded.password_hash,
      token_hash = excluded.token_hash,
      request_ip_hash = excluded.request_ip_hash,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).run(email, hashPassword(password), tokenHash, ipHash, expiresAt, now, now)

  const verifyUrl = `${appBaseUrl(event)}/register/verify#token=${encodeURIComponent(token)}`
  try {
    await sendVerificationEmail(email, verifyUrl, tokenHash)
  } catch (error) {
    await db.prepare('DELETE FROM pending_registrations WHERE email = ? AND token_hash = ?').run(email, tokenHash)
    throw error
  }
}

export async function verifyEmailRegistration(event: H3Event, rawToken: unknown): Promise<{ id: number; username: string }> {
  const token = String(rawToken ?? '')
  if (token.length < 32 || token.length > 128) {
    throw createError({ statusCode: 400, statusMessage: '验证链接无效' })
  }
  const now = Date.now()
  const tokenHash = sha256(token)
  const db = useDb()
  const pending = await db.prepare(`
    SELECT email, password_hash, request_ip_hash, expires_at
    FROM pending_registrations WHERE token_hash = ?
  `).get(tokenHash) as {
    email: string
    password_hash: string
    request_ip_hash: string
    expires_at: number
  } | null
  if (!pending || pending.expires_at < now) {
    if (pending) await db.prepare('DELETE FROM pending_registrations WHERE token_hash = ?').run(tokenHash)
    throw createError({ statusCode: 410, statusMessage: '验证链接无效或已过期，请重新注册' })
  }

  const duplicate = await db.prepare(
    'SELECT id FROM users WHERE lower(email) = ? OR lower(username) = ? LIMIT 1',
  ).get(pending.email, pending.email) as { id: number } | null
  if (duplicate) {
    await db.prepare('DELETE FROM pending_registrations WHERE token_hash = ?').run(tokenHash)
    throw createError({ statusCode: 409, statusMessage: '该邮箱已注册，请直接登录' })
  }

  const day = registrationDayKey(now)
  let reservedSlot: number | null = null
  let insertedUserId: number | null = null
  try {
    // 逐槽 INSERT OR IGNORE：主键 (ip_hash, day_key, slot) 在并发请求下也只允许
    // 一个写入成功，因此不会出现先 COUNT 再 INSERT 的竞态超额。
    for (let slot = 1; slot <= MAX_REGISTRATIONS_PER_IP_DAY; slot++) {
      const result = await db.prepare(`
        INSERT OR IGNORE INTO registration_ip_slots (ip_hash, day_key, slot, email, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(pending.request_ip_hash, day, slot, pending.email, now)
      if (result.changes > 0) {
        reservedSlot = slot
        break
      }
    }
    if (reservedSlot === null) throw createError({ statusCode: 429, statusMessage: '该网络今日注册账号数已达上限' })

    const storageNamespace = crypto.randomBytes(16).toString('hex')
    const inserted = await db.prepare(`
      INSERT INTO users
        (username, email, email_verified_at, storage_namespace, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      pending.email, pending.email, now, storageNamespace, pending.password_hash, now, now,
    ) as UserRecord | null
    if (!inserted) throw new Error('user insert returned no row')
    insertedUserId = inserted.id

    await db.batch([
      db.d1.prepare(`
        UPDATE registration_ip_slots SET user_id = ?
         WHERE ip_hash = ? AND day_key = ? AND slot = ? AND email = ? AND user_id IS NULL
      `).bind(inserted.id, pending.request_ip_hash, day, reservedSlot, pending.email),
      db.d1.prepare('DELETE FROM pending_registrations WHERE token_hash = ?').bind(tokenHash),
    ])
    const { token: sessionToken, expiresAt } = await createSession(inserted.id)
    setSessionCookie(event, sessionToken, expiresAt)
    setAuthCacheCookie(event, sessionToken, {
      id: inserted.id,
      username: inserted.username,
      avatar: inserted.avatar,
      nickname: inserted.nickname,
    }, expiresAt)
    return { id: inserted.id, username: inserted.username }
  } catch (error) {
    // 用户行一旦创建，槽位即使还没成功回填 user_id 也必须保留（每日计数按槽位
    // 行统计），否则后续故障回滚可能产生一个未计入限额的有效账号。
    if (reservedSlot !== null && insertedUserId === null) {
      await db.prepare(`
        DELETE FROM registration_ip_slots
         WHERE ip_hash = ? AND day_key = ? AND slot = ? AND email = ? AND user_id IS NULL
      `).run(pending.request_ip_hash, day, reservedSlot, pending.email)
    }
    throw error
  }
}
