import { requireUserId } from '~~/server/utils/auth'
/// <reference types="@cloudflare/workers-types" />
import { useDb, type ProviderRecord, type ModelRecord } from '~~/server/utils/db'
import { serializeProvider } from '~~/server/utils/serialize'

// 复制一个平台及其下全部模型到新平台「原名-copy」。
// 除名称外全部沿用原平台（含 base_url / api_key / api_format / enabled / notes）；
// 模型逐条复制，行 id 由自增新生成（自然不同），model_id 等配置保持一致。
// 例外：polish_model 是全局唯一开关，复制品一律置 0，避免抢走原模型的润色标记。
//
// 「刷新不丢」：平台 + 全部模型放进一个 D1 batch 原子事务——要么全部落库、
// 要么全不落，复制途中刷新绝不会留下「平台建了、模型只复制一半」的残缺状态；
// 单次 batch 往返也远快于 N+1 次串行 INSERT，慢窗口大幅缩短。再用 waitUntil
// 兜底：即使客户端刷新断开，Worker 仍把这批写完。batch 内模型的 provider_id
// 走 (SELECT id FROM providers WHERE name=?) 子查询——名称唯一、事务内可见，
// 无需中途读取新自增 id。
export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const idStr = getRouterParam(event, 'id')
  const id = Number(idStr)
  if (!id || Number.isNaN(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid provider id' })
  }
  const db = useDb()
  const src = await db
    .prepare('SELECT * FROM providers WHERE id = ? AND user_id = ?')
    .get(id, userId) as ProviderRecord | null
  if (!src) throw createError({ statusCode: 404, statusMessage: 'Provider not found' })

  // 平台名称唯一：优先「原名-copy」，占用则追加序号「原名-copy-2」…
  const existing = await db
    .prepare('SELECT name FROM providers WHERE user_id = ?')
    .all(userId) as { name: string }[]
  const taken = new Set(existing.map((r) => r.name))
  const base = `${src.name}-copy`
  let name = base
  let n = 2
  while (taken.has(name)) name = `${base}-${n++}`

  const models = await db
    .prepare('SELECT * FROM models WHERE provider_id = ? AND user_id = ? ORDER BY id ASC')
    .all(id, userId) as ModelRecord[]

  const now = Date.now()
  const d1 = db.d1
  // 一个原子事务：先插平台，再插全部模型（provider_id 用子查询取新平台 id）。
  const stmts: D1PreparedStatement[] = [
    d1
      .prepare(
        `INSERT INTO providers (user_id, name, base_url, api_key, api_format, enabled, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(userId, name, src.base_url, src.api_key, src.api_format, src.enabled, src.notes, now, now),
    ...models.map((m) =>
      d1
        .prepare(
          `INSERT INTO models (user_id, provider_id, model_id, display_name, kind, default_params, enabled, price_mode, price_cny, price_in_cny, price_out_cny, price_novideo_cny, price_video_cny, polish_model, keys, created_at, updated_at)
           VALUES (?, (SELECT id FROM providers WHERE user_id = ? AND name = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          userId, userId, name,
          m.model_id,
          m.display_name,
          m.kind,
          m.default_params,
          m.enabled,
          m.price_mode,
          m.price_cny,
          m.price_in_cny,
          m.price_out_cny,
          m.price_novideo_cny,
          m.price_video_cny,
          0, // polish_model 全局唯一，复制品置 0
          m.keys,
          now,
          now,
        ),
    ),
  ]

  // waitUntil 兜底：客户端刷新/断开也让这批 batch 跑完（生产由 event.context 提供）。
  const waitUntil = (event.context as any).waitUntil as ((p: Promise<unknown>) => void) | undefined
  const batchPromise = db.batch(stmts)
  if (waitUntil) waitUntil(batchPromise)
  await batchPromise

  const row = await db.prepare('SELECT * FROM providers WHERE user_id = ? AND name = ?').get(userId, name) as ProviderRecord
  return { provider: serializeProvider(row), models: models.length }
})
