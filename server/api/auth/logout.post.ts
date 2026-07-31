import { clearSessionCookie, destroySession, getSessionToken } from '~~/server/utils/auth'

export default defineEventHandler(async (event) => {
  const token = getSessionToken(event)
  if (token) await destroySession(token)
  clearSessionCookie(event)
  return { ok: true }
})
