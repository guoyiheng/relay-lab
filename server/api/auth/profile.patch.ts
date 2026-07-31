import { useDb, hashPassword, verifyPassword, type UserRecord } from '~~/server/utils/db'
import { clearAuthCacheCookie, getCurrentUser, getSessionToken } from '~~/server/utils/auth'

export default defineEventHandler(async (event) => {
  const user = await getCurrentUser(event)
  if (!user) throw createError({ statusCode: 401, statusMessage: '未登录' })

  const body = await readBody<{
    nickname?: string
    avatar?: string
    currentPassword?: string
    newPassword?: string
  }>(event)

  const db = useDb()
  const updates: string[] = []
  const values: any[] = []
  let passwordChanged = false

  // 更新昵称
  if (body.nickname !== undefined) {
    const nickname = body.nickname.trim()
    updates.push('nickname = ?')
    values.push(nickname || null)
  }

  // 更新头像（base64）
  if (body.avatar !== undefined) {
    updates.push('avatar = ?')
    values.push(body.avatar || null)
  }

  // 修改密码需要验证当前密码
  if (body.newPassword) {
    if (body.newPassword.length < 10 || body.newPassword.length > 128) {
      throw createError({ statusCode: 400, statusMessage: '密码长度需为 10–128 位' })
    }
    if (!body.currentPassword) {
      throw createError({ statusCode: 400, statusMessage: '修改密码需要提供当前密码' })
    }
    const currentUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as UserRecord
    if (!currentUser || !verifyPassword(body.currentPassword, currentUser.password_hash)) {
      throw createError({ statusCode: 400, statusMessage: '当前密码错误' })
    }
    const newPasswordHash = hashPassword(body.newPassword)
    updates.push('password_hash = ?')
    values.push(newPasswordHash)
    passwordChanged = true
  }

  if (!updates.length) {
    return { ok: true }
  }

  updates.push('updated_at = ?')
  values.push(Date.now())
  values.push(user.id)

  await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  if (passwordChanged) {
    const currentToken = getSessionToken(event)
    if (currentToken) {
      await db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, currentToken)
    } else {
      await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id)
    }
  }
  // The short-lived signed auth cookie contains username/nickname metadata.
  // Clear it after profile or password changes so the next guarded request
  // revalidates the backing session/user row instead of serving stale claims.
  clearAuthCacheCookie(event)

  return { ok: true }
})
