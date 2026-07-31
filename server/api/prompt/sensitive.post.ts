import { requireUserId } from '~~/server/utils/auth'
import { runSensitive } from '~~/server/utils/analysis'

// 敏感词分析：找出可能触发审核的敏感描述，给出「不改变原意」的中性替换，
// 并产出一份改正后的完整提示词。处理逻辑与「结构化分析」一致。
export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const body = await readBody<{ prompt?: string; kind?: 'image' | 'video' }>(event)
  const prompt = (body?.prompt || '').trim()
  const kind = body?.kind === 'video' ? 'video' : 'image'
  if (!prompt) throw createError({ statusCode: 400, statusMessage: '请填写提示词' })
  return await runSensitive(userId, prompt, kind)
})
