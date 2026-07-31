import { requireUserId } from '~~/server/utils/auth'
import { runStructured } from '~~/server/utils/analysis'

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const body = await readBody<{ prompt?: string; kind?: 'image' | 'video' }>(event)
  const prompt = (body?.prompt || '').trim()
  const kind = body?.kind === 'video' ? 'video' : 'image'
  if (!prompt) throw createError({ statusCode: 400, statusMessage: '请填写提示词' })
  return await runStructured(userId, prompt, kind)
})
