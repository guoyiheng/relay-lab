import { useDb, type ApiFormat } from '~~/server/utils/db'
import { requireUserId } from '~~/server/utils/auth'

const VALID: ApiFormat[] = ['openai-sync', 'openai-async', 'xai-image', 'doubao-video']

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const body = await readBody<{
    providers?: Array<{
      name: string
      base_url: string
      api_key?: string
      api_format: ApiFormat
      enabled: boolean
      notes?: string | null
      ark_access_key?: string | null
      ark_secret_key?: string | null
      ark_region?: string | null
      ark_project_name?: string | null
    }>
    models?: Array<{
      provider_name: string
      model_id: string
      display_name?: string
      kind: 'image' | 'video' | 'text'
      default_params?: Record<string, unknown> | null
      enabled: boolean
      price_mode?: string | null
      price_cny?: number | null
      price_in_cny?: number | null
      price_out_cny?: number | null
      price_novideo_cny?: number | null
      price_video_cny?: number | null
      polish_model?: boolean
      keys?: Array<{ name?: string; key: string; enabled?: boolean }>
    }>
  }>(event)

  const providersData = body?.providers || []
  const modelsData = body?.models || []

  if (!providersData.length && !modelsData.length) {
    throw createError({ statusCode: 400, statusMessage: '导入数据为空' })
  }

  const db = useDb()
  const now = Date.now()
  const createdProviders: Record<string, number> = {}
  const results = { providers: 0, models: 0, errors: [] as string[] }

  // 导入平台
  for (const p of providersData) {
    try {
      const name = p.name.trim()
      const base_url = p.base_url.trim().replace(/\/+$/, '')
      const api_key = (p.api_key || '').trim()
      const api_format = p.api_format
      const ark_access_key = (p.ark_access_key || '').trim() || null
      const ark_secret_key = (p.ark_secret_key || '').trim() || null
      const ark_region = (p.ark_region || '').trim() || null
      const ark_project_name = (p.ark_project_name || '').trim() || null

      if (!name) {
        results.errors.push(`平台名称为空，跳过`)
        continue
      }
      if (!base_url) {
        results.errors.push(`平台 ${name} 的 Base URL 为空，跳过`)
        continue
      }
      if (!VALID.includes(api_format)) {
        results.errors.push(`平台 ${name} 的 API 协议无效，跳过`)
        continue
      }

      // 检查是否已存在同名平台
      const existing = await db.prepare('SELECT id FROM providers WHERE user_id = ? AND name = ?').get(userId, name) as { id: number } | null
      if (existing) {
        createdProviders[name] = existing.id
        continue
      }

      const result = await db
        .prepare(
          `INSERT INTO providers (user_id, name, base_url, api_key, api_format, enabled, notes,
             ark_access_key, ark_secret_key, ark_region, ark_project_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId, name,
          base_url,
          api_key,
          api_format,
          p.enabled ? 1 : 0,
          p.notes ?? null,
          ark_access_key,
          ark_secret_key,
          ark_region,
          ark_project_name,
          now,
          now,
        )
      const id = Number(result.lastInsertRowid)
      createdProviders[name] = id
      results.providers++
    } catch (err: any) {
      results.errors.push(`导入平台 ${p.name} 失败: ${err?.message || '未知错误'}`)
    }
  }

  // 导入模型
  for (const m of modelsData) {
    try {
      const providerName = m.provider_name.trim()
      let providerId = createdProviders[providerName]

      if (!providerId) {
        const existingProvider = await db.prepare('SELECT id FROM providers WHERE user_id = ? AND name = ?')
          .get(userId, providerName) as { id: number } | null
        providerId = existingProvider?.id
        if (providerId) createdProviders[providerName] = providerId
      }

      if (!providerId) {
        results.errors.push(`模型 ${m.model_id} 的平台 ${providerName} 未导入或不存在，跳过`)
        continue
      }

      const model_id = m.model_id.trim()
      if (!model_id) {
        results.errors.push(`模型 ID 为空，跳过`)
        continue
      }

      // 检查同一平台下是否已存在相同 model_id
      const existing = await db
        .prepare('SELECT id FROM models WHERE user_id = ? AND provider_id = ? AND model_id = ?')
        .get(userId, providerId, model_id) as { id: number } | null
      if (existing) {
        results.errors.push(`模型 ${model_id} 在平台 ${providerName} 下已存在，跳过`)
        continue
      }

      const defaultParamsStr = m.default_params ? JSON.stringify(m.default_params) : null
      const keysStr = m.keys && m.keys.length ? JSON.stringify(m.keys) : null

      await db.prepare(
        `INSERT INTO models (user_id, provider_id, model_id, display_name, kind, default_params, enabled, price_mode, price_cny, price_in_cny, price_out_cny, price_novideo_cny, price_video_cny, polish_model, keys, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        userId, providerId,
        model_id,
        m.display_name || null,
        m.kind,
        defaultParamsStr,
        m.enabled ? 1 : 0,
        m.price_mode || null,
        m.price_cny ?? null,
        m.price_in_cny ?? null,
        m.price_out_cny ?? null,
        m.price_novideo_cny ?? null,
        m.price_video_cny ?? null,
        m.polish_model ? 1 : 0,
        keysStr,
        now,
        now,
      )
      results.models++
    } catch (err: any) {
      results.errors.push(`导入模型 ${m.model_id} 失败: ${err?.message || '未知错误'}`)
    }
  }

  return results
})
