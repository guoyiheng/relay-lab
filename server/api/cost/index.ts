import { useDb, type CostEntryRecord } from '~~/server/utils/db'

// 成本表仅 xxn 用户可访问（页面 + 接口双重 gate）。
function assertXxn(event: any) {
  const user = event.context.user as { username?: string } | undefined
  if (!user || user.username !== 'xxn') {
    throw createError({ statusCode: 403, statusMessage: '无权访问' })
  }
}

function serialize(r: CostEntryRecord) {
  return {
    id: r.id,
    category: r.category,
    kind: r.kind,
    model: r.model,
    provider: r.provider,
    price_mode: r.price_mode,
    resolution: r.resolution,
    duration_s: r.duration_s,
    cost_cny: r.cost_cny,
    points: r.points,
    note: r.note,
    sort: r.sort,
  }
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}

export default defineEventHandler(async (event) => {
  assertXxn(event)
  const db = useDb()

  if (event.method === 'GET') {
    const rows = await db.prepare('SELECT * FROM cost_entries ORDER BY sort ASC, id ASC').all() as CostEntryRecord[]
    return rows.map(serialize)
  }

  if (event.method === 'POST') {
    const body = await readBody<Partial<CostEntryRecord>>(event)
    const category = (body?.category || '').toString().trim()
    const model = (body?.model || '').toString().trim()
    const kind = body?.kind === 'video' ? 'video' : 'image'
    if (!category) throw createError({ statusCode: 400, statusMessage: '请填写模式/类别' })
    if (!model) throw createError({ statusCode: 400, statusMessage: '请填写模型' })
    const cost = num(body?.cost_cny)
    if (cost == null || cost < 0) throw createError({ statusCode: 400, statusMessage: '成本必须是非负数' })
    const now = Date.now()
    const maxSort = (await db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM cost_entries').get() as { m: number }).m
    const r = await db.prepare(
      `INSERT INTO cost_entries (category, kind, model, provider, price_mode, resolution, duration_s, cost_cny, points, note, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      category, kind, model,
      (body?.provider || '').toString().trim() || null,
      (body?.price_mode || '').toString().trim() || null,
      (body?.resolution || '').toString().trim() || null,
      num(body?.duration_s),
      cost,
      body?.points != null ? Math.round(Number(body.points)) : null,
      (body?.note || '').toString().trim() || null,
      maxSort + 1, now, now,
    )
    const row = await db.prepare('SELECT * FROM cost_entries WHERE id = ?').get(Number(r.lastInsertRowid)) as CostEntryRecord
    return serialize(row)
  }

  throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
})
