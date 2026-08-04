import { useDb, type ProviderRecord, type ModelRecord, type ApiFormat } from '~~/server/utils/db'
import { serializeProvider, serializeModel } from '~~/server/utils/serialize'
import { requireUserId } from '~~/server/utils/auth'
import { normalizeProviderUrl } from '~~/shared/provider-url'

const VALID: ApiFormat[] = ['openai-sync', 'openai-async', 'xai-image', 'doubao-video', 'full-url']

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const method = event.method
  const db = useDb()

  if (method === 'GET') {
    const startedAt = performance.now()
    // D1 batch executes both reads in one database round trip. The previous
    // sequential awaits added a full edge-to-primary RTT even though each SQL
    // statement itself takes well under a millisecond.
    const results = await db.batch([
      db.d1.prepare('SELECT * FROM providers WHERE user_id = ? ORDER BY created_at DESC').bind(userId),
      db.d1.prepare('SELECT * FROM models WHERE user_id = ? ORDER BY id ASC').bind(userId),
    ])
    const providerResult = results[0]
    const modelResult = results[1]
    if (!providerResult?.success || !modelResult?.success) {
      throw createError({ statusCode: 500, statusMessage: '读取平台配置失败' })
    }
    const rows = providerResult.results as unknown as ProviderRecord[]
    const models = modelResult.results as unknown as ModelRecord[]
    const list = rows.map(serializeProvider)
    if (!list.length) {
      appendHeader(event, 'Server-Timing', `app;dur=${(performance.now() - startedAt).toFixed(1)};desc="providers"`)
      return list
    }
    const grouped = new Map<number, ReturnType<typeof serializeModel>[]>()
    const providerNames = new Map(rows.map((provider) => [provider.id, provider.name]))
    for (const m of models) {
      const arr = grouped.get(m.provider_id) || []
      arr.push(serializeModel(m, providerNames.get(m.provider_id)))
      grouped.set(m.provider_id, arr)
    }
    const body = list.map((p) => ({ ...p, models: grouped.get(p.id) || [] }))
    appendHeader(event, 'Server-Timing', `app;dur=${(performance.now() - startedAt).toFixed(1)};desc="providers"`)
    return body
  }

  if (method === 'POST') {
    const body = await readBody<{
      name?: string
      base_url?: string
      api_key?: string
      api_format?: string
      enabled?: boolean
      notes?: string | null
      ark_access_key?: string | null
      ark_secret_key?: string | null
      ark_region?: string | null
      ark_project_name?: string | null
    }>(event)
    const name = (body?.name || '').trim()
    const api_key = (body?.api_key || '').trim()
    const api_format = body?.api_format as ApiFormat
    const base_url = normalizeProviderUrl(body?.base_url || '', api_format)
    const ark_access_key = (body?.ark_access_key || '').trim() || null
    const ark_secret_key = (body?.ark_secret_key || '').trim() || null
    const ark_region = (body?.ark_region || '').trim() || null
    const ark_project_name = (body?.ark_project_name || '').trim() || null
    if (!name) throw createError({ statusCode: 400, statusMessage: '请填写平台名称' })
    if (!base_url) throw createError({ statusCode: 400, statusMessage: '请填写 Base URL' })
    if (!api_key) throw createError({ statusCode: 400, statusMessage: '请填写 API Key' })
    if (!VALID.includes(api_format)) {
      throw createError({ statusCode: 400, statusMessage: '不支持的 API 协议' })
    }
    // 平台名称唯一
    const dup = await db.prepare('SELECT id FROM providers WHERE user_id = ? AND name = ?').get(userId, name) as { id: number } | null
    if (dup) throw createError({ statusCode: 400, statusMessage: '平台名称已存在，请换一个' })
    const now = Date.now()
    const result = await db
      .prepare(
        `INSERT INTO providers (user_id, name, base_url, api_key, api_format, enabled, notes,
           ark_access_key, ark_secret_key, ark_region, ark_project_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        name,
        base_url,
        api_key,
        api_format,
        body?.enabled === false ? 0 : 1,
        body?.notes ?? null,
        ark_access_key,
        ark_secret_key,
        ark_region,
        ark_project_name,
        now,
        now,
      )
    const id = Number(result.lastInsertRowid)
    const row = await db.prepare('SELECT * FROM providers WHERE id = ? AND user_id = ?').get(id, userId) as ProviderRecord
    return serializeProvider(row)
  }

  throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
})
