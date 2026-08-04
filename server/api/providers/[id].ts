import { useDb, type ProviderRecord, type ApiFormat } from '~~/server/utils/db'
import { serializeProvider } from '~~/server/utils/serialize'
import { requireUserId } from '~~/server/utils/auth'
import { normalizeProviderUrl } from '~~/shared/provider-url'

const VALID: ApiFormat[] = ['openai-sync', 'openai-async', 'xai-image', 'doubao-video', 'full-url']

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const idStr = getRouterParam(event, 'id')
  const id = Number(idStr)
  if (!id || Number.isNaN(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid provider id' })
  }
  const db = useDb()
  const existing = await db
    .prepare('SELECT * FROM providers WHERE id = ? AND user_id = ?')
    .get(id, userId) as ProviderRecord | null
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'Provider not found' })

  if (event.method === 'GET') return serializeProvider(existing)

  if (event.method === 'PATCH') {
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
    const updates: string[] = []
    const values: any[] = []
    if (body?.name !== undefined) {
      const name = body.name.trim()
      if (!name) throw createError({ statusCode: 400, statusMessage: '名称不能为空' })
      // 平台名称唯一（排除自身）
      const dup = await db.prepare('SELECT id FROM providers WHERE user_id = ? AND name = ? AND id != ?').get(userId, name, id) as { id: number } | null
      if (dup) throw createError({ statusCode: 400, statusMessage: '平台名称已存在，请换一个' })
      updates.push('name = ?')
      values.push(name)
    }
    if (body?.base_url !== undefined) {
      const nextFormat = (body.api_format as ApiFormat | undefined) || existing.api_format
      const base_url = normalizeProviderUrl(body.base_url, nextFormat)
      if (!base_url) throw createError({ statusCode: 400, statusMessage: 'Base URL 不能为空' })
      updates.push('base_url = ?')
      values.push(base_url)
    }
    if (body?.api_key !== undefined) {
      const api_key = body.api_key.trim()
      if (!api_key) throw createError({ statusCode: 400, statusMessage: 'API Key 不能为空' })
      updates.push('api_key = ?')
      values.push(api_key)
    }
    if (body?.api_format !== undefined) {
      if (!VALID.includes(body.api_format as ApiFormat)) {
        throw createError({ statusCode: 400, statusMessage: '不支持的 API 协议' })
      }
      updates.push('api_format = ?')
      values.push(body.api_format)
    }
    if (body?.enabled !== undefined) {
      updates.push('enabled = ?')
      values.push(body.enabled ? 1 : 0)
    }
    if (body?.notes !== undefined) {
      updates.push('notes = ?')
      values.push(body.notes)
    }
    // Seedance 素材库控制面凭证（空串视为清空 → NULL）。改 AK/SK/project 时顺带清掉缓存的组 id。
    let arkResetGroup = false
    if (body?.ark_access_key !== undefined) {
      const v = (body.ark_access_key || '').trim()
      updates.push('ark_access_key = ?'); values.push(v || null); arkResetGroup = true
    }
    if (body?.ark_secret_key !== undefined) {
      const v = (body.ark_secret_key || '').trim()
      updates.push('ark_secret_key = ?'); values.push(v || null); arkResetGroup = true
    }
    if (body?.ark_region !== undefined) {
      const v = (body.ark_region || '').trim()
      updates.push('ark_region = ?'); values.push(v || null); arkResetGroup = true
    }
    if (body?.ark_project_name !== undefined) {
      const v = (body.ark_project_name || '').trim()
      updates.push('ark_project_name = ?'); values.push(v || null); arkResetGroup = true
    }
    if (arkResetGroup) {
      updates.push('ark_asset_group_id = ?'); values.push(null)
    }
    if (!updates.length) return serializeProvider(existing)
    updates.push('updated_at = ?')
    values.push(Date.now())
    values.push(id)
    await db.prepare(`UPDATE providers SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...values, userId)
    const row = await db.prepare('SELECT * FROM providers WHERE id = ? AND user_id = ?').get(id, userId) as ProviderRecord
    return serializeProvider(row)
  }

  if (event.method === 'DELETE') {
    await db.prepare('DELETE FROM providers WHERE id = ? AND user_id = ?').run(id, userId)
    return { ok: true }
  }

  throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
})
