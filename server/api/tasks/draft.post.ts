import { useDb, type ModelRecord, type ProviderRecord, type TaskRecord } from '~~/server/utils/db'
import { requireUserId } from '~~/server/utils/auth'
import { serializeTask } from '~~/server/utils/serialize'

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const body = await readBody<{ provider_id?: number; model_id?: number; prompt?: string; params?: Record<string, unknown> }>(event)
  const providerId = Number(body?.provider_id)
  const modelId = Number(body?.model_id)
  const prompt = String(body?.prompt || '').trim()
  if (!providerId || !modelId || !prompt) throw createError({ statusCode: 400, statusMessage: '平台、模型和提示词不能为空' })
  const db = useDb()
  const provider = await db.prepare('SELECT * FROM providers WHERE id = ? AND user_id = ?').get(providerId, userId) as ProviderRecord | null
  if (!provider || !provider.enabled) throw createError({ statusCode: 400, statusMessage: '平台不存在或已禁用' })
  const model = await db.prepare('SELECT * FROM models WHERE id = ? AND user_id = ?').get(modelId, userId) as ModelRecord | null
  if (!model || model.provider_id !== provider.id || !model.enabled) throw createError({ statusCode: 400, statusMessage: '模型不存在或已禁用' })
  const now = Date.now()
  const inserted = await db.prepare(`INSERT INTO tasks (
    user_id, provider_id, provider_name, model_id, model_name, kind, api_format,
    prompt, params, request_payload, status, price_mode, price_cny, price_in_cny,
    price_out_cny, price_novideo_cny, price_video_cny, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(
    userId, provider.id, provider.name, model.id, model.display_name || model.model_id, model.kind,
    provider.api_format, prompt, JSON.stringify(body.params || {}), model.price_mode ?? null,
    model.price_cny ?? null, model.price_in_cny ?? null, model.price_out_cny ?? null,
    model.price_novideo_cny ?? null, model.price_video_cny ?? null, now, now,
  ) as { id: number } | null
  const id = Number(inserted?.id)
  if (!id) throw createError({ statusCode: 500, statusMessage: '创建任务失败' })
  const row = await db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, userId) as TaskRecord
  return serializeTask(row, { providerBaseUrl: provider.base_url, providerName: provider.name, modelName: model.display_name || model.model_id })
})
