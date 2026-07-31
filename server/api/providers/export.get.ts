import { useDb, type ProviderRecord, type ModelRecord } from '~~/server/utils/db'
import { requireUserId } from '~~/server/utils/auth'

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const db = useDb()

  // 获取所有平台
  const providers = await db
    .prepare('SELECT * FROM providers WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as ProviderRecord[]

  if (!providers.length) {
    return { providers: [], models: [] }
  }

  const providerIds = providers.map((p) => p.id)
  const placeholders = providerIds.map(() => '?').join(',')

  // 获取所有模型
  const models = await db
    .prepare(`SELECT * FROM models WHERE user_id = ? AND provider_id IN (${placeholders}) ORDER BY id ASC`)
    .all(userId, ...providerIds) as ModelRecord[]

  // 配置文件用于完整迁移，凭证按明文导出。
  const exportProviders = providers.map((p) => ({
    name: p.name,
    base_url: p.base_url,
    api_key: p.api_key,
    api_format: p.api_format,
    enabled: p.enabled === 1,
    notes: p.notes,
    ark_access_key: p.ark_access_key,
    ark_secret_key: p.ark_secret_key,
    ark_region: p.ark_region,
    ark_project_name: p.ark_project_name,
  }))

  const exportModels = models.map((m) => ({
    provider_name: providers.find((p) => p.id === m.provider_id)?.name,
    model_id: m.model_id,
    display_name: m.display_name,
    kind: m.kind,
    default_params: m.default_params ? JSON.parse(m.default_params) : null,
    enabled: m.enabled === 1,
    price_mode: m.price_mode,
    price_cny: m.price_cny,
    price_in_cny: m.price_in_cny,
    price_out_cny: m.price_out_cny,
    price_novideo_cny: m.price_novideo_cny,
    price_video_cny: m.price_video_cny,
    polish_model: m.polish_model === 1,
    keys: m.keys ? JSON.parse(m.keys) : [],
  }))

  return {
    providers: exportProviders,
    models: exportModels,
    exported_at: new Date().toISOString(),
  }
})
