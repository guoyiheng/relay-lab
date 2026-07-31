import { findChatModel, chatComplete, stripJsonFences, resolveModelKey } from '~~/server/utils/llm'

// 成本表智能添加：把自然语言描述解析成一条结构化成本数据（不入库，返回给前端预填表单）。
// 仅 xxn 用户、需已配置文本模型。
export default defineEventHandler(async (event) => {
  const user = event.context.user as { id?: number; username?: string } | undefined
  if (!user || user.username !== 'xxn') throw createError({ statusCode: 403, statusMessage: '无权访问' })

  const body = await readBody<{ text?: string }>(event)
  const text = (body?.text || '').trim()
  if (!text) throw createError({ statusCode: 400, statusMessage: '请输入描述' })

  const found = await findChatModel(Number(user.id))
  if (!found) throw createError({ statusCode: 400, statusMessage: '未配置文本模型，请先在平台页配置一个文本模型' })
  const { provider, model } = found

  const system = `你的任务是把用户输入的一条自然语言计价描述，解析成结构化 JSON。`
    + `字段：category(模式/类别，如 文生图、参考生视频、首尾帧视频)、kind(image 或 video)、`
    + `model(模型名)、provider(供应商，如 T8、老张)、price_mode(per_call 按次 / per_mtoken 按量 / per_second 按秒，图片一般 per_call，视频一般 per_second)、`
    + `resolution(分辨率，如 720P/1080P/4k，没有则 null)、duration_s(时长秒数，数字，没有则 null)、cost_cny(成本，单位元，数字)、points(积分，整数，用户没说则 null)。`
    + `只返回严格 JSON，不要 markdown、不要解释。格式：`
    + `{ "category": "", "kind": "image|video", "model": "", "provider": "", "price_mode": "per_call|per_mtoken|per_second", "resolution": null, "duration_s": null, "cost_cny": 0, "points": null }`

  const raw = await chatComplete({
    baseUrl: provider.base_url,
    apiKey: resolveModelKey(provider, model),
    model: model.model_id,
    system,
    user: text,
    temperature: 0.2,
  })

  try {
    const obj = JSON.parse(stripJsonFences(raw))
    if (!obj || typeof obj !== 'object') throw new Error('not object')
    return {
      category: typeof obj.category === 'string' ? obj.category : '',
      kind: obj.kind === 'video' ? 'video' : 'image',
      model: typeof obj.model === 'string' ? obj.model : '',
      provider: typeof obj.provider === 'string' ? obj.provider : '',
      price_mode: ['per_call', 'per_mtoken', 'per_second'].includes(obj.price_mode) ? obj.price_mode : null,
      resolution: typeof obj.resolution === 'string' ? obj.resolution : null,
      duration_s: typeof obj.duration_s === 'number' ? obj.duration_s : null,
      cost_cny: typeof obj.cost_cny === 'number' ? obj.cost_cny : null,
      points: typeof obj.points === 'number' ? Math.round(obj.points) : null,
    }
  } catch {
    throw createError({ statusCode: 422, statusMessage: '解析失败，请换种说法或手动填写' })
  }
})
