import { getRouterParam } from 'h3'
import { useDb, type CostEntryRecord } from '~~/server/utils/db'

function assertXxn(event: any) {
  const user = event.context.user as { username?: string } | undefined
  if (!user || user.username !== 'xxn') {
    throw createError({ statusCode: 403, statusMessage: '无权访问' })
  }
}
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}

export default defineEventHandler(async (event) => {
  assertXxn(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!id || Number.isNaN(id)) throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
  const db = useDb()

  if (event.method === 'PATCH') {
    const body = await readBody<Partial<CostEntryRecord>>(event)
    const updates: string[] = []
    const values: any[] = []
    const setStr = (k: string, v: unknown) => { updates.push(`${k} = ?`); values.push((v ?? '').toString().trim() || null) }
    if (body?.category !== undefined) { const v = (body.category || '').toString().trim(); if (!v) throw createError({ statusCode: 400, statusMessage: '类别不能为空' }); updates.push('category = ?'); values.push(v) }
    if (body?.model !== undefined) { const v = (body.model || '').toString().trim(); if (!v) throw createError({ statusCode: 400, statusMessage: '模型不能为空' }); updates.push('model = ?'); values.push(v) }
    if (body?.kind !== undefined) { updates.push('kind = ?'); values.push(body.kind === 'video' ? 'video' : 'image') }
    if (body?.provider !== undefined) setStr('provider', body.provider)
    if (body?.price_mode !== undefined) setStr('price_mode', body.price_mode)
    if (body?.resolution !== undefined) setStr('resolution', body.resolution)
    if (body?.note !== undefined) setStr('note', body.note)
    if (body?.duration_s !== undefined) { updates.push('duration_s = ?'); values.push(num(body.duration_s)) }
    if (body?.cost_cny !== undefined) { const c = num(body.cost_cny); if (c == null || c < 0) throw createError({ statusCode: 400, statusMessage: '成本必须是非负数' }); updates.push('cost_cny = ?'); values.push(c) }
    if (body?.points !== undefined) { updates.push('points = ?'); values.push(body.points != null && body.points !== ('' as any) ? Math.round(Number(body.points)) : null) }
    if (!updates.length) return { ok: true }
    updates.push('updated_at = ?'); values.push(Date.now())
    values.push(id)
    await db.prepare(`UPDATE cost_entries SET ${updates.join(', ')} WHERE id = ?`).run(...values)
    return { ok: true }
  }

  if (event.method === 'DELETE') {
    await db.prepare('DELETE FROM cost_entries WHERE id = ?').run(id)
    return { ok: true }
  }

  throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
})
