import { requireUserId } from '~~/server/utils/auth'
import { findChatModel, chatComplete, resolveModelKey } from '~~/server/utils/llm'

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const body = await readBody<{ prompt?: string; kind?: 'image' | 'video'; customCommand?: string }>(event)
  const prompt = (body?.prompt || '').trim()
  const kind = body?.kind === 'video' ? 'video' : 'image'
  const customCommand = (body?.customCommand || '').trim()
  if (!prompt) throw createError({ statusCode: 400, statusMessage: '请填写提示词' })

  const found = await findChatModel(userId)
  if (!found) {
    throw createError({
      statusCode: 400,
      statusMessage: '未找到 gpt-5.5 文本模型，请先在平台页为 T8 添加 model_id 为 gpt-5.5 的模型',
    })
  }
  const { provider, model } = found

  const taskLabel = kind === 'image' ? '生图' : '生视频'
  // 无论默认还是自定义命令，都追加统一的输出约束：只返回润色后的提示词本身，
  // 不解释做了什么，不加前言/markdown，总长度控制在 2000 字以内。
  const OUTPUT_RULE = `\n\n【输出要求】只返回优化后的提示词文本本身，直接可用；`
    + `不要输出任何解释、说明、前言、总结或「我做了什么」之类的内容；`
    + `不要 JSON、不要 markdown、不要引号包裹；总长度控制在 2000 字以内。`
  const base = customCommand
    || `你是一位富有创意的提示词优化师，擅长为${taskLabel}模型优化提示词。`
      + `把用户输入改写成一段精炼、生动、可直接用于${taskLabel}的提示词。`
  const system = base + OUTPUT_RULE

  const raw = await chatComplete({
    baseUrl: provider.base_url,
    apiKey: resolveModelKey(provider, model),
    model: model.model_id,
    system,
    user: prompt,
    temperature: 0.8,
  })

  // 服务端兜底：即便模型超出，也截断到 2000 字，保证前端拿到的即最终结果。
  const polished = (raw || '').trim().slice(0, 2000)
  return { polished }
})
