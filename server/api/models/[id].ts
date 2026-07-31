import { useDb, type ModelRecord, type ProviderRecord, type ModelKind, type PriceMode } from '~~/server/utils/db'
import { serializeModel } from '~~/server/utils/serialize'
import { requireUserId } from '~~/server/utils/auth'

const VALID_KINDS: ModelKind[] = ['image', 'video', 'text']
const VALID_PRICE_MODES: PriceMode[] = ['per_call', 'per_mtoken', 'per_mtoken_video']

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
  const id = Number(getRouterParam(event, 'id'))
  if (!id || Number.isNaN(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid model id' })
  }
  const db = useDb()
  const existing = await db
    .prepare('SELECT * FROM models WHERE id = ? AND user_id = ?')
    .get(id, userId) as ModelRecord | null
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'Model not found' })

  if (event.method === 'GET') {
    const provider = await db
      .prepare('SELECT * FROM providers WHERE id = ? AND user_id = ?')
      .get(existing.provider_id, userId) as ProviderRecord | null
    return serializeModel(existing, provider?.name)
  }

  if (event.method === 'PATCH') {
    const body = await readBody<{
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
    const updates: string[] = []
    const values: any[] = []
    const numOrNull = (v: unknown): number | null => {
      if (v === null || v === undefined || v === '') return null
      const n = Number(v)
      if (Number.isNaN(n) || n < 0) throw createError({ statusCode: 400, statusMessage: '价格必须是非负数' })
      return n
    }
    if (body?.model_id !== undefined) {
      const v = body.model_id.trim()
      if (!v) throw createError({ statusCode: 400, statusMessage: '模型 ID 不能为空' })
      updates.push('model_id = ?'); values.push(v)
    }
    if (body?.display_name !== undefined) {
      updates.push('display_name = ?'); values.push(body.display_name || null)
    }
    if (body?.kind !== undefined) {
      if (!VALID_KINDS.includes(body.kind as ModelKind)) {
        throw createError({ statusCode: 400, statusMessage: '类型必须为 image / video / text' })
      }
      updates.push('kind = ?'); values.push(body.kind)
    }
    if (body?.default_params !== undefined) {
      let text: string | null = null
      if (body.default_params !== null) {
        try { text = JSON.stringify(body.default_params) }
        catch { throw createError({ statusCode: 400, statusMessage: 'default_params 不是合法 JSON' }) }
      }
      updates.push('default_params = ?'); values.push(text)
    }
    if (body?.enabled !== undefined) {
      updates.push('enabled = ?'); values.push(body.enabled ? 1 : 0)
    }
    const priceTouched = ['price_mode', 'price_cny', 'price_in_cny', 'price_out_cny', 'price_novideo_cny', 'price_video_cny']
      .some((key) => key in (body || {}))
    if (priceTouched) {
      const rawMode = body.price_mode !== undefined ? body.price_mode : existing.price_mode
      const priceMode = rawMode === null || rawMode === '' ? null : rawMode as PriceMode
      if (priceMode && !VALID_PRICE_MODES.includes(priceMode)) {
        throw createError({ statusCode: 400, statusMessage: '计价模式不合法' })
      }
      const source = {
        price_cny: body.price_cny !== undefined ? body.price_cny : existing.price_cny,
        price_in_cny: body.price_in_cny !== undefined ? body.price_in_cny : existing.price_in_cny,
        price_out_cny: body.price_out_cny !== undefined ? body.price_out_cny : existing.price_out_cny,
        price_novideo_cny: body.price_novideo_cny !== undefined ? body.price_novideo_cny : existing.price_novideo_cny,
        price_video_cny: body.price_video_cny !== undefined ? body.price_video_cny : existing.price_video_cny,
      }
      let priceCny: number | null = null
      let priceIn: number | null = null
      let priceOut: number | null = null
      let priceNovideo: number | null = null
      let priceVideo: number | null = null
      if (priceMode === 'per_call') priceCny = numOrNull(source.price_cny)
      else if (priceMode === 'per_mtoken') {
        priceCny = numOrNull(source.price_cny)
        priceIn = numOrNull(source.price_in_cny)
        priceOut = numOrNull(source.price_out_cny)
      } else if (priceMode === 'per_mtoken_video') {
        priceNovideo = numOrNull(source.price_novideo_cny)
        priceVideo = numOrNull(source.price_video_cny)
      }
      updates.push(
        'price_mode = ?', 'price_cny = ?', 'price_in_cny = ?', 'price_out_cny = ?',
        'price_novideo_cny = ?', 'price_video_cny = ?',
      )
      values.push(priceMode, priceCny, priceIn, priceOut, priceNovideo, priceVideo)
    }
    if (body?.keys !== undefined) { updates.push('keys = ?'); values.push(normalizeKeys(body.keys)) }
    let setPolish = false
    if (body?.polish_model !== undefined) {
      updates.push('polish_model = ?'); values.push(body.polish_model ? 1 : 0)
      setPolish = !!body.polish_model
    }
    if (!updates.length) return serializeModel(existing)
    updates.push('updated_at = ?'); values.push(Date.now())
    values.push(id, userId)
    try {
      await db.prepare(`UPDATE models SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...values)
      // Polish is mutually exclusive — clear it on all other models.
      if (setPolish) await db.prepare('UPDATE models SET polish_model = 0 WHERE user_id = ? AND id != ?').run(userId, id)
    } catch (err: any) {
      if (String(err?.message || '').includes('UNIQUE')) {
        throw createError({ statusCode: 409, statusMessage: '该平台下已存在同名模型' })
      }
      throw err
    }
    const row = await db.prepare('SELECT * FROM models WHERE id = ? AND user_id = ?').get(id, userId) as ModelRecord
    const provider = await db
      .prepare('SELECT * FROM providers WHERE id = ? AND user_id = ?')
      .get(row.provider_id, userId) as ProviderRecord | null
    return serializeModel(row, provider?.name)
  }

  if (event.method === 'DELETE') {
    await db.prepare('DELETE FROM models WHERE id = ? AND user_id = ?').run(id, userId)
    return { ok: true }
  }

  throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
})
