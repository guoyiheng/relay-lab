import { getCurrentUser } from '~~/server/utils/auth'

export default defineEventHandler(async (event) => {
  const startedAt = performance.now()
  const user = await getCurrentUser(event, { fresh: true })
  appendHeader(event, 'Server-Timing', `auth;dur=${(performance.now() - startedAt).toFixed(1)};desc="fresh-d1"`)
  return { user }
})
