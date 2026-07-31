import { useDb, type ModelRecord, type ProviderRecord, type ModelKind, type PriceMode } from '~~/server/utils/db'
import { serializeModel } from '~~/server/utils/serialize'
import { requireUserId } from '~~/server/utils/auth'

const VALID_KINDS: ModelKind[] = ['image', 'video', 'text']
const VALID_PRICE_MODES: PriceMode[] = ['per_call', 'per_mtoken', 'per_mtoken_video']

// Normalize a keys payload → JSON string of {name?,key,enabled}[] or null.
function normalizeKeys(input: unknown): string | null {
  if (!Array.isArray(input)) return null
  const arr = input
    .map((k: any) => ({
      name: typeof k?.name === 'string' ? k.name.trim() : undefined,
      key: typeof k?.key === 'string' ? k.key.trim() : '',
      enabled: k?.enabled !== false,
    }))
    .filter((k) => k.key)
  return arr.length ? JSON.stringify(arr) : null
}

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const db = useDb()
  if (event.method === 'GET') {
    const query = getQuery(event)
    const providerId = query.provider_id ? Number(query.provider_id) : null
    const kind = (query.kind as string) || null
    const where: string[] = ['m.user_id = ?']
    const args: any[] = [userId]
    if (providerId) { where.push('m.provider_id = ?'); args.push(providerId) }
    if (kind && VALID_KINDS.includes(kind as ModelKind)) {
      where.push('m.kind = ?'); args.push(kind)
    }
    const sql = `
      SELECT m.*, p.name as provider_name
      FROM models m
      LEFT JOIN providers p ON p.id = m.provider_id AND p.user_id = m.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY m.id ASC
    `
    const rows = await db.prepare(sql).all(...args) as (ModelRecord & { provider_name: string | null })[]
    return rows.map((r) => serializeModel(r, r.provider_name || undefined))
  }

  if (event.method === 'POST') {
    const body = await readBody<{
      provider_id?: number
      model_id?: string
      display_name?: string | null
      kind?: string
      default_params?: unknown
      enabled?: boolean
      price_mode?: string | null
      price_cny?: number | string | null
      price_in_cny?: number | string | null
      price_out_cny?: number | string | null
      price_novideo_cny?: number | string | null
      price_video_cny?: number | string | null
      polish_model?: boolean
      keys?: unknown
    }>(event)
    const provider_id = Number(body?.provider_id)
    const model_id = (body?.model_id || '').trim()
    const kind = body?.kind as ModelKind
    if (!provider_id) throw createError({ statusCode: 400, statusMessage: '请选择平台' })
    if (!model_id) throw createError({ statusCode: 400, statusMessage: '请填写模型 ID' })
    if (!VALID_KINDS.includes(kind)) {
      throw createError({ statusCode: 400, statusMessage: '类型必须为 image / video / text' })
    }
    const provider = await db
      .prepare('SELECT * FROM providers WHERE id = ? AND user_id = ?')
      .get(provider_id, userId) as ProviderRecord | null
    if (!provider) throw createError({ statusCode: 400, statusMessage: '平台不存在' })

    let paramsText: string | null = null
    if (body?.default_params !== undefined && body.default_params !== null) {
      try { paramsText = JSON.stringify(body.default_params) }
      catch { throw createError({ statusCode: 400, statusMessage: 'default_params 不是合法 JSON' }) }
    }

    let priceMode: PriceMode | null = null
    let priceCny: number | null = null
    let priceIn: number | null = null
    let priceOut: number | null = null
    let priceNovideo: number | null = null
    let priceVideo: number | null = null
    const num = (v: unknown): number | null => {
      if (v === null || v === undefined || v === '') return null
      const n = Number(v)
      if (Number.isNaN(n) || n < 0) throw createError({ statusCode: 400, statusMessage: '价格必须是非负数' })
      return n
    }
    if (body?.price_mode) {
      if (!VALID_PRICE_MODES.includes(body.price_mode as PriceMode)) {
        throw createError({ statusCode: 400, statusMessage: '计价模式不合法' })
      }
      priceMode = body.price_mode as PriceMode
      if (priceMode === 'per_mtoken') {
        // 按量：提示/补全分开
        priceIn = num(body?.price_in_cny)
        priceOut = num(body?.price_out_cny)
        priceCny = num(body?.price_cny) // 兼容旧单价（可空）
      } else if (priceMode === 'per_mtoken_video') {
        // Seedance：按输入是否含视频分两档
        priceNovideo = num(body?.price_novideo_cny)
        priceVideo = num(body?.price_video_cny)
      } else {
        priceCny = num(body?.price_cny)
      }
    }
    const keysJson = normalizeKeys(body?.keys)
    const polish = body?.polish_model ? 1 : 0

    const now = Date.now()
    try {
      const result = await db
        .prepare(
          `INSERT INTO models (user_id, provider_id, model_id, display_name, kind, default_params, enabled, price_mode, price_cny, price_in_cny, price_out_cny, price_novideo_cny, price_video_cny, polish_model, keys, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId, provider_id,
          model_id,
          body?.display_name || null,
          kind,
          paramsText,
          body?.enabled === false ? 0 : 1,
          priceMode,
          priceCny,
          priceIn,
          priceOut,
          priceNovideo,
          priceVideo,
          polish,
          keysJson,
          now,
          now,
        )
      const id = Number(result.lastInsertRowid)
      // Polish is mutually exclusive — if this model is the polish model, clear others.
      if (polish) await db.prepare('UPDATE models SET polish_model = 0 WHERE user_id = ? AND id != ?').run(userId, id)
      const row = await db.prepare('SELECT * FROM models WHERE id = ? AND user_id = ?').get(id, userId) as ModelRecord
      return serializeModel(row, provider.name)
    } catch (err: any) {
      if (String(err?.message || '').includes('UNIQUE')) {
        throw createError({ statusCode: 409, statusMessage: '该平台下已存在同名模型' })
      }
      throw err
    }
  }

  throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
})
