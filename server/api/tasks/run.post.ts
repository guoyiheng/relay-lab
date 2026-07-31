import {
  useDb,
  type ProviderRecord,
  type ModelRecord,
  type TaskRecord,
  type AssetRecord,
  type AssetKind,
  type ApiFormat,
} from '~~/server/utils/db'
import { requireUserId } from '~~/server/utils/auth'
import { r2PublicUrl } from '~~/server/utils/storage'
import { buildRequestPayload, type ReferenceAsset, type OrderedSegment } from '~~/server/utils/adapters'
import { startTask } from '~~/server/utils/taskrunner'
import { serializeTask } from '~~/server/utils/serialize'

const LIMITS: Record<AssetKind, number> = { image: 9, video: 3, audio: 3 }
const ASSET_KINDS: AssetKind[] = ['image', 'video', 'audio']

async function loadAsset(id: string, userId: number): Promise<AssetRecord> {
  const row = await useDb().prepare('SELECT * FROM assets WHERE id = ? AND user_id = ?').get(id, userId) as AssetRecord | null
  if (!row) throw createError({ statusCode: 400, statusMessage: `素材 ${id} 不存在` })
  return row
}

// 参考素材给上游 provider 的可拉取 URL：直连 R2 公开域（assets.relay.yiheng.run）。
function refPublicUrl(asset: AssetRecord): string {
  return r2PublicUrl(asset.r2_key)
}

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const body = await readBody<{
    provider_id?: number
    model_id?: number
    prompt?: string
    params?: Record<string, unknown>
    refs?: { image?: string[]; video?: string[]; audio?: string[] }
    segments?: Array<
      | { type: 'text'; text?: string }
      | { type: 'ref'; upload_id?: string; kind?: AssetKind }
    >
  }>(event)
  const provider_id = Number(body?.provider_id)
  const model_id = Number(body?.model_id)
  const prompt = (body?.prompt || '').trim()
  if (!provider_id) throw createError({ statusCode: 400, statusMessage: '请选择平台' })
  if (!model_id) throw createError({ statusCode: 400, statusMessage: '请选择模型' })
  if (!prompt) throw createError({ statusCode: 400, statusMessage: '请填写提示词' })

  const db = useDb()
  const provider = await db
    .prepare('SELECT * FROM providers WHERE id = ? AND user_id = ?')
    .get(provider_id, userId) as ProviderRecord | null
  if (!provider) throw createError({ statusCode: 400, statusMessage: '平台不存在' })
  if (!provider.enabled) {
    throw createError({ statusCode: 400, statusMessage: '该平台已被禁用' })
  }
  const model = await db
    .prepare('SELECT * FROM models WHERE id = ? AND user_id = ?')
    .get(model_id, userId) as ModelRecord | null
  if (!model || model.provider_id !== provider.id) {
    throw createError({ statusCode: 400, statusMessage: '模型不存在或不属于所选平台' })
  }
  if (!model.enabled) {
    throw createError({ statusCode: 400, statusMessage: '该模型已被禁用' })
  }

  const params = body?.params && typeof body.params === 'object' ? body.params : {}

  // Resolve and validate references
  const refIdsByKind: Record<AssetKind, string[]> = {
    image: (body?.refs?.image || []).filter(Boolean) as string[],
    video: (body?.refs?.video || []).filter(Boolean) as string[],
    audio: (body?.refs?.audio || []).filter(Boolean) as string[],
  }
  for (const k of ASSET_KINDS) {
    if (refIdsByKind[k].length > LIMITS[k]) {
      const label = k === 'image' ? '参考图' : k === 'video' ? '参考视频' : '参考音频'
      throw createError({ statusCode: 400, statusMessage: `${label}最多 ${LIMITS[k]} 个` })
    }
  }

  const refsByKind: Record<AssetKind, ReferenceAsset[]> = { image: [], video: [], audio: [] }
  const refRows: { kind: AssetKind; idx: number; asset_id: string }[] = []
  for (const k of ASSET_KINDS) {
    const ids = refIdsByKind[k]
    for (let i = 0; i < ids.length; i++) {
      const assetId = ids[i]
      if (!assetId) continue
      const asset = await loadAsset(assetId, userId)
      if (asset.kind !== k) {
        throw createError({ statusCode: 400, statusMessage: `素材 ${asset.id} 类型不匹配` })
      }
      // 参考素材直接给 R2 公开 URL，provider 侧自行拉取（不再内联 base64）。
      // asset_id 供 Seedance 素材库入库缓存（进程内路径用，见 taskrunner.ingestRefsInProcess）。
      refsByKind[k].push({ kind: k, public_url: refPublicUrl(asset), asset_id: asset.id })
      refRows.push({ kind: k, idx: i, asset_id: asset.id })
    }
  }

  // Resolve ordered segments (inline @-mention chips interleaved with text).
  // Each ref segment's asset id → a ReferenceAsset, the same way refsByKind is
  // built. When present, this drives ordered multimodal `content[]` assembly.
  let orderedSegments: OrderedSegment[] | undefined
  if (Array.isArray(body?.segments) && body.segments.length) {
    const out: OrderedSegment[] = []
    for (const seg of body.segments) {
      if (seg?.type === 'text') {
        out.push({ type: 'text', text: String(seg.text ?? '') })
      } else if (seg?.type === 'ref' && seg.upload_id) {
        const asset = await loadAsset(seg.upload_id, userId)
        const kind = (seg.kind || asset.kind) as AssetKind
        if (asset.kind !== kind) {
          throw createError({ statusCode: 400, statusMessage: `素材 ${asset.id} 类型不匹配` })
        }
        out.push({
          type: 'ref',
          asset: { kind, public_url: refPublicUrl(asset), asset_id: asset.id },
        })
      }
    }
    if (out.some((s) => s.type === 'ref')) orderedSegments = out
  }

  // Model-level independent key takes precedence over the platform key. Pick the
  // first enabled key from model.keys; fall back to provider.api_key.
  let effectiveKey = provider.api_key
  if (model.keys) {
    try {
      const parsed = JSON.parse(model.keys) as { key: string; enabled?: boolean }[]
      const first = Array.isArray(parsed) ? parsed.find((k) => k.enabled !== false && k.key) : null
      if (first?.key) effectiveKey = first.key
    } catch { /* keep provider key */ }
  }

  // Build the upstream payload synchronously so request_payload is visible in
  // the UI immediately (before the adapter even attempts the call).
  const initialPayload = buildRequestPayload(provider.api_format as any, {
    baseUrl: provider.base_url,
    apiKey: effectiveKey,
    modelId: model.model_id,
    kind: model.kind,
    prompt,
    params,
    refs: refsByKind,
    segments: orderedSegments,
  })

  const now = Date.now()
  // D1 无交互式事务：先 INSERT tasks 用 RETURNING 拿 id，再 batch 落 task_assets。
  // 二者非原子——task_assets 失败不影响任务本身可见（refs 仅用于详情展示），可接受。
  const inserted = await db
    .prepare(
      `INSERT INTO tasks (
         user_id, provider_id, provider_name, model_id, model_name, kind, api_format,
         prompt, params, request_payload, status,
         price_mode, price_cny, price_in_cny, price_out_cny, price_novideo_cny, price_video_cny,
         created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      userId,
      provider.id,
      provider.name,
      model.id,
      model.display_name || model.model_id,
      model.kind,
      provider.api_format,
      prompt,
      JSON.stringify(params),
      JSON.stringify(initialPayload),
      // Price snapshot — freeze the model's current rate onto the task so a
      // later price change won't rewrite this task's historical cost.
      model.price_mode ?? null,
      model.price_cny ?? null,
      model.price_in_cny ?? null,
      model.price_out_cny ?? null,
      model.price_novideo_cny ?? null,
      model.price_video_cny ?? null,
      now,
      now,
    ) as { id: number } | null
  const id = Number(inserted?.id)
  if (!id) throw createError({ statusCode: 500, statusMessage: '创建任务失败' })
  if (refRows.length) {
    await db.batch([
      ...refRows.map((row) =>
        db.d1
          .prepare('INSERT INTO task_assets (user_id, task_id, kind, idx, asset_id) VALUES (?, ?, ?, ?, ?)')
          .bind(userId, id, row.kind, row.idx, row.asset_id),
      ),
      // Reusing an older local upload grants it the same seven-day window as
      // this task. xxn tasks have NULL assets_expires_at, so remain permanent.
      db.d1.prepare(`
        UPDATE assets
        SET expires_at = (SELECT assets_expires_at FROM tasks WHERE id = ? AND user_id = ?)
        WHERE user_id = ?
          AND id IN (${refRows.map(() => '?').join(',')})
          AND (SELECT assets_expires_at FROM tasks WHERE id = ? AND user_id = ?) IS NOT NULL
          AND (expires_at IS NULL OR expires_at < (SELECT assets_expires_at FROM tasks WHERE id = ? AND user_id = ?))
      `).bind(
        id, userId,
        userId, ...refRows.map((row) => row.asset_id),
        id, userId,
        id, userId,
      ),
    ])
  }

  // 起后台执行：生产上所有协议都先发 Queue；异步协议持久轮询，同步/text 协议由
  // run-sync consumer 完成，避免最长 5 分钟的 Provider 请求依赖 HTTP waitUntil。
  // 只有本地 dev / 缺失 Queue 才回退进程内执行。前端轮询 GET /api/tasks/{id}。
  const waitUntil = (event.context as any).waitUntil as ((p: Promise<unknown>) => void) | undefined
  await startTask(id, userId, provider.api_format as ApiFormat, model.kind, {
    baseUrl: provider.base_url,
    apiKey: effectiveKey,
    modelId: model.model_id,
    prompt,
    params,
    refs: refsByKind,
    segments: orderedSegments,
  }, waitUntil, provider)

  const row = await db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, userId) as TaskRecord
  return serializeTask(row, {
    providerBaseUrl: provider.base_url,
    providerName: provider.name,
    modelName: model.display_name || model.model_id,
  })
})
