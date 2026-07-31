import { useDb, verifyPassword, type UserRecord } from '~~/server/utils/db'
import { createSession, setAuthCacheCookie, setSessionCookie } from '~~/server/utils/auth'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ username?: string; password?: string }>(event)
  const username = (body?.username || '').trim().toLowerCase()
  const password = body?.password || ''
  if (!username || !password) {
    throw createError({ statusCode: 400, statusMessage: '请填写账号和密码' })
  }
  const user = await useDb()
    .prepare(`SELECT * FROM users WHERE lower(username) = ? OR lower(email) = ? LIMIT 1`)
    .get(username, username) as UserRecord | null
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw createError({ statusCode: 401, statusMessage: '账号或密码错误' })
  }
  const { token, expiresAt } = await createSession(user.id)
  setSessionCookie(event, token, expiresAt)
  setAuthCacheCookie(event, token, {
    id: user.id,
    username: user.username,
    avatar: user.avatar,
    nickname: user.nickname,
  }, expiresAt)
  return { id: user.id, username: user.username }
})
