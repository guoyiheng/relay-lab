/// <reference types="@cloudflare/workers-types" />
import { useDb, useQueue, type ProviderRecord, type ModelRecord, type TaskRecord, type ModelKind, type ApiFormat, type AssetKind } from './db'
import { resolveModelKey } from './llm'
import { resultKey, putObject, extFor, r2PublicUrl } from './storage'
import { registerGeneratedAsset } from './assets'
import { parsePublicHttpUrl, readResponseBytes } from './remote-fetch'
import {
  runAdapter, runPreparedSyncTask, submitAsyncTask, pollAsyncOnce, adapterSupportsKind,
  rewriteContentToAssetUris, buildRequestPayload,
  type AdapterResult, type ReferenceAsset, type OrderedSegment,
} from './adapters'
import {
  providerHasArkCreds, ensureAssetGroupId, ensureAssetIds, checkAssetsActive, ingestRefsBlocking,
  type RefItem,
} from './seedance-assets'

// ─────────────────────────────────────────────────────────────────────────────
// 任务执行编排。原 fire-and-forget 长轮询在 Workers 上活不过单次请求，故拆两条路径：
//   · 生产（有 TASK_QUEUE binding）：run.post 只落库+发一条队列消息，本 Worker 作
//     Cloudflare Queues 消费者驱动「提交 submit → 单次轮询 poll → 未终态带 delay 重新
//     入队」，累计 elapsed 判超时。见 server/plugins/task-queue.ts 的 cloudflare:queue 钩子。
//   · 无队列（本地 nuxt dev / 未付费）：回退进程内 runAdapter 长轮询（Node 下可长活）。
// 同步协议（text / openai-sync / xai-image）也进入 Queue 的 run-sync phase，避免最长 5 分钟的
// Provider 调用依赖 HTTP invocation 的 waitUntil 生命周期。仅本地 dev / 无 Queue 时回退进程内。
// ─────────────────────────────────────────────────────────────────────────────

const RESULT_MAX_BYTES = 30 * 1024 * 1024
// 队列轮询上限与间隔（与 adapters 的进程内路径一致）：视频 10min/5s，其余 5min/2s。
const IMAGE_MAX_MS = 5 * 60 * 1000
const VIDEO_MAX_MS = 10 * 60 * 1000
const IMAGE_GAP_S = 2
const VIDEO_GAP_S = 5
function maxMsFor(kind: ModelKind) { return kind === 'video' ? VIDEO_MAX_MS : IMAGE_MAX_MS }
function gapSecFor(kind: ModelKind) { return kind === 'video' ? VIDEO_GAP_S : IMAGE_GAP_S }

// 队列消息：run-sync=同步调用；submit=异步首次提交；poll=轮询一次。
export interface TaskMessage {
  taskId: number
  phase: 'prepare-assets' | 'run-sync' | 'submit' | 'poll'
  startedAt?: number   // 首次提交成功后的时间戳（poll 阶段带）；prepare-assets 用作入库起始
  pollUrl?: string     // submit 阶段解析出的轮询 URL（poll 阶段带）
}

// 参考素材走 Seedance 素材库的入库超时（prepare-assets 阶段累计上限）。
const ASSET_INGEST_MAX_MS = 3 * 60 * 1000
const ASSET_INGEST_GAP_S = 2

// 生成结果转存 R2 存链接（图/视频，<30MB）；否则保留上游 URL。Uint8Array 无 Buffer。
// 返回 { url, r2Key, mime }：r2Key 非空表示成功转存到我方 R2（可登记为 generated 素材）；
// 保留远端（超大/失败）时 r2Key 为 null。
async function persistResultToR2(
  url: string, storageNamespace: string, taskId: number, idx: number,
): Promise<{ url: string; r2Key: string | null; mime: string | null }> {
  try {
    const target = parsePublicHttpUrl(url)
    const res = await fetch(target.toString(), { redirect: 'error' })
    if (!res.ok) return { url, r2Key: null, mime: null }
    const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || null
    const buf = await readResponseBytes(res, RESULT_MAX_BYTES)
    const key = resultKey(storageNamespace, taskId, idx, extFor(contentType, url.split('?')[0]))
    await putObject(key, buf, { contentType })
    return { url: r2PublicUrl(key), r2Key: key, mime: contentType }
  } catch {
    return { url, r2Key: null, mime: null }
  }
}

// 把终态结果写回 tasks 行（含结果转存 R2 + 登记为可复用的 generated 素材）。
// latencyMs 可选（队列路径用 startedAt 算）。kind 用于给 generated asset 打类型标签。
async function persistTerminal(taskId: number, r: AdapterResult, latencyMs: number | null, kind?: ModelKind) {
  const db = useDb()
  const owner = await db.prepare(`
    SELECT t.user_id, u.storage_namespace
      FROM tasks t JOIN users u ON u.id = t.user_id
     WHERE t.id = ?
  `).get(taskId) as { user_id: number; storage_namespace: string } | null
  if (!owner) return
  let resultUrls = r.result_urls || []
  // 结果转存 R2（拿到 r2Key），result_urls 落库存转存后的公开链接；同时为每个成功转存的
  // 结果登记一行 generated asset（source=generated，幂等 by task_id+result_idx），使其可被
  // 当作参考素材复用（用 asset id 引用，不再重新下载导入）。text 无 result_urls，自然跳过。
  if (resultUrls.length) {
    const assetKind: AssetKind | null = kind === 'video' ? 'video' : kind === 'image' ? 'image' : null
    const persisted = await Promise.all(resultUrls.map((u, i) => persistResultToR2(u, owner.storage_namespace, taskId, i)))
    resultUrls = persisted.map((p) => p.url)
    if (assetKind) {
      await Promise.all(
        persisted.map((p, i) => registerGeneratedAsset(taskId, i, p.r2Key, assetKind, p.mime)),
      )
    }
  }
  const finishedAt = Date.now()
  try {
    await db.prepare(
      `UPDATE tasks SET
         status = ?, http_status = ?, latency_ms = ?,
         response_payload = ?, result_urls = ?, result_text = ?,
         remote_task_id = ?, error_message = ?, updated_at = ?, finished_at = ?
       WHERE id = ? AND user_id = ?`,
    ).run(
      r.status,
      r.http_status ?? null,
      latencyMs,
      JSON.stringify(r.response_payload ?? null),
      JSON.stringify(resultUrls),
      r.result_text ?? null,
      r.remote_task_id || null,
      r.error_message || null,
      finishedAt,
      finishedAt,
      taskId,
      owner.user_id,
    )
  } catch (err) {
    console.error(`[taskrunner] persist terminal for #${taskId} failed:`, err)
  }
}

// 起一个任务：生产只要有 Queue 就入队；异步协议走 submit/poll，同步协议走 run-sync。
// ctx 提供 refs/segments/params，仅本地回退路径用；Queue 路径复用已落库的 request_payload。
// waitUntil 仅作为无 Queue 时的兼容回退，不再承载正常生产的多分钟 Provider 调用。
export async function startTask(
  taskId: number,
  userId: number,
  format: ApiFormat,
  kind: ModelKind,
  runCtx: { baseUrl: string; apiKey: string; modelId: string; prompt: string; params: Record<string, unknown>; refs: Record<'image' | 'video' | 'audio', ReferenceAsset[]>; segments?: OrderedSegment[] },
  waitUntil?: (p: Promise<unknown>) => void,
  provider?: ProviderRecord,
) {
  const queue = useQueue()
  const isAsync = kind !== 'text' && (format === 'openai-async' || format === 'doubao-video') && adapterSupportsKind(format, kind)
  if (queue) {
    if (isAsync) {
      // doubao-video 且勾选「参考走素材库」→ 先入库（prepare-assets），再 submit；否则直接 submit。
      const useAssetLib = format === 'doubao-video' && !!runCtx.params?.use_asset_library
      const hasRefs = runCtx.refs.image.length + runCtx.refs.video.length + runCtx.refs.audio.length > 0
      const phase: TaskMessage['phase'] = useAssetLib && hasRefs ? 'prepare-assets' : 'submit'
      await queue.send({ taskId, phase } satisfies TaskMessage)
    } else {
      await queue.send({ taskId, phase: 'run-sync' } satisfies TaskMessage)
    }
    return
  }
  // 回退：仅本地 dev / 缺失 Queue 时进程内跑完。生产配置应始终有 Queue。
  const job = runInProcess(taskId, userId, format, kind, runCtx, provider)
  if (waitUntil) waitUntil(job); else void job
}

async function runInProcess(
  taskId: number,
  userId: number,
  format: ApiFormat,
  kind: ModelKind,
  ctx: { baseUrl: string; apiKey: string; modelId: string; prompt: string; params: Record<string, unknown>; refs: Record<'image' | 'video' | 'audio', ReferenceAsset[]>; segments?: OrderedSegment[] },
  provider?: ProviderRecord,
) {
  const startedAt = Date.now()
  let result: AdapterResult
  try {
    // 参考走素材库（doubao-video + 勾选）：runAdapter 前先把参考素材入库并把 ctx 里的 URL 换成 asset://<id>。
    // 入库后 ctx 里的 URL 已是 asset://，据此重算 request_payload 落库——否则请求 tab 停留在公开 URL，
    // 与真实发出的 asset:// 不一致（队列路径在 prepare-assets 阶段已落库改写，进程内需在此补上）。
    if (format === 'doubao-video' && provider && ctx.params?.use_asset_library) {
      await ingestRefsInProcess(provider, ctx)
      try {
        const realPayload = buildRequestPayload(format, { ...ctx, kind })
        await useDb().prepare('UPDATE tasks SET request_payload = ?, updated_at = ? WHERE id = ? AND user_id = ?')
          .run(JSON.stringify(realPayload), Date.now(), taskId, userId)
      } catch (err) { console.error(`[taskrunner] rewrite request_payload #${taskId}:`, err) }
    }
    result = await runAdapter(format, {
      ...ctx,
      kind,
      onCreated: async ({ remote_task_id, response_payload }) => {
        try {
          await useDb().prepare(
            `UPDATE tasks SET response_payload = ?, remote_task_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
          ).run(JSON.stringify(response_payload ?? null), remote_task_id || null, Date.now(), taskId, userId)
        } catch (err) { console.error(`[taskrunner] onCreated persist #${taskId}:`, err) }
      },
    })
  } catch (err: any) {
    result = { status: 'failed', request_payload: null, response_payload: null, result_urls: [], error_message: err?.message || String(err) }
  }
  await persistTerminal(taskId, result, Date.now() - startedAt, kind)
}

// 进程内路径：把 ctx.refs / ctx.segments 里的参考素材入库（阻塞轮询到 Active），
// 再把这些对象的 public_url 原地换成 asset://<id>，让 buildDoubaoContent 直接产出 asset 引用。
async function ingestRefsInProcess(
  provider: ProviderRecord,
  ctx: { refs: Record<'image' | 'video' | 'audio', ReferenceAsset[]>; segments?: OrderedSegment[] },
) {
  if (!providerHasArkCreds(provider)) {
    throw new Error('该平台未配置素材库 AK/SK，无法「参考走素材库」')
  }
  const items: RefItem[] = []
  const seen = new Set<string>()
  const collect = (a: ReferenceAsset) => {
    if (!a.asset_id || !a.public_url || seen.has(a.public_url)) return
    seen.add(a.public_url)
    items.push({ assetDbId: a.asset_id, public_url: a.public_url, kind: a.kind })
  }
  for (const k of ['image', 'video', 'audio'] as const) ctx.refs[k].forEach(collect)
  ctx.segments?.forEach((s) => { if (s.type === 'ref') collect(s.asset) })
  if (!items.length) return

  const urlToAssetId = await ingestRefsBlocking(provider, items)
  const rewrite = (a: ReferenceAsset) => {
    const id = urlToAssetId.get(a.public_url)
    if (id) a.public_url = `asset://${id}`
  }
  for (const k of ['image', 'video', 'audio'] as const) ctx.refs[k].forEach(rewrite)
  ctx.segments?.forEach((s) => { if (s.type === 'ref') rewrite(s.asset) })
}

// ── 队列消费者：处理一条 TaskMessage（submit 或 poll）────────────────────────────
// 返回 next：null=本条到终态无需续；否则是要重新入队的下一条消息 + delaySeconds。
export async function handleTaskMessage(
  msg: TaskMessage,
): Promise<{ next: TaskMessage; delaySeconds: number } | null> {
  const db = useDb()
  // 重新解析 provider/model（密钥不落任务行，从 live 表取），并读回已落库的 request_payload。
  const row = await db.prepare(`
    SELECT t.user_id, t.kind, t.api_format, t.request_payload, t.remote_task_id, t.status,
           t.provider_id, t.model_id
    FROM tasks t WHERE t.id = ? AND t.deleted_at IS NULL
  `).get(msg.taskId) as Pick<TaskRecord, 'user_id' | 'kind' | 'api_format' | 'request_payload' | 'remote_task_id' | 'status' | 'provider_id' | 'model_id'> | null
  if (!row) return null                              // 任务已删
  if (row.status === 'succeeded' || row.status === 'failed') return null  // 已终态

  const provider = row.provider_id
    ? await db.prepare('SELECT * FROM providers WHERE id = ? AND user_id = ?').get(row.provider_id, row.user_id) as ProviderRecord | null
    : null
  const model = row.model_id
    ? await db.prepare('SELECT * FROM models WHERE id = ? AND user_id = ?').get(row.model_id, row.user_id) as ModelRecord | null
    : null
  if (!provider || !model) {
    await persistTerminal(msg.taskId, { status: 'failed', request_payload: null, response_payload: null, result_urls: [], error_message: '平台或模型已删除，任务终止' }, null)
    return null
  }
  const apiKey = resolveModelKey(provider, model)
  const format = row.api_format as ApiFormat
  const kind = row.kind as ModelKind
  const payload = row.request_payload ? JSON.parse(row.request_payload) : {}

  if (msg.phase === 'run-sync') {
    const isSyncFormat = format === 'openai-sync' || format === 'xai-image' || format === 'full-url'
    if (kind !== 'text' && (!isSyncFormat || !adapterSupportsKind(format, kind))) {
      await persistTerminal(msg.taskId, {
        status: 'failed', request_payload: payload, response_payload: null, result_urls: [],
        error_message: `任务协议 ${format}/${kind} 不能使用 run-sync phase`,
      }, null)
      return null
    }
    const startedAt = Date.now()
    const result = await runPreparedSyncTask({
      format,
      baseUrl: provider.base_url,
      apiKey,
      kind,
      payload: payload && typeof payload === 'object' ? payload : {},
    })
    await persistTerminal(msg.taskId, result, Date.now() - startedAt, kind)
    return null
  }

  if (msg.phase === 'prepare-assets') {
    // 参考素材走 Seedance 素材库：建组 + 入库拿 asset id → 改写已落库 content[] 为 asset://<id>
    // → 轮询到全部 Active 才转 submit。仍 Processing 带 delay 重排本 phase；Failed/超时判失败。
    if (!providerHasArkCreds(provider)) {
      await persistTerminal(msg.taskId, { status: 'failed', request_payload: payload, response_payload: null, result_urls: [], error_message: '该平台未配置素材库 AK/SK，无法「参考走素材库」' }, null)
      return null
    }
    // 读该任务的参考素材（task_assets → assets 拿 r2_key 拼公开 URL，与 content[] 里的原始 URL 对齐）。
    const refRows = await db.prepare(`
      SELECT ta.kind AS kind, a.id AS asset_id, a.r2_key AS r2_key
      FROM task_assets ta JOIN assets a ON a.id = ta.asset_id AND a.user_id = ta.user_id
      WHERE ta.task_id = ? AND ta.user_id = ? ORDER BY ta.kind, ta.idx
    `).all(msg.taskId, row.user_id) as { kind: AssetKind; asset_id: string; r2_key: string }[]
    const items: RefItem[] = refRows.map((r) => ({ assetDbId: r.asset_id, public_url: r2PublicUrl(r.r2_key), kind: r.kind }))
    if (!items.length) {
      // 没有参考素材：无需入库，直接转 submit。
      return { next: { taskId: msg.taskId, phase: 'submit' }, delaySeconds: 1 }
    }
    const startedAt = msg.startedAt || Date.now()
    try {
      const groupId = await ensureAssetGroupId(provider)
      const { urlToAssetId, assetIds } = await ensureAssetIds(provider, groupId, items)
      // 改写已落库 request_payload 的 content[] → asset://（幂等，重排时重复调用无副作用）。
      if (Array.isArray(payload?.content)) {
        payload.content = rewriteContentToAssetUris(payload.content, urlToAssetId)
        await db.prepare('UPDATE tasks SET request_payload = ?, updated_at = ? WHERE id = ? AND user_id = ?')
          .run(JSON.stringify(payload), Date.now(), msg.taskId, row.user_id)
      }
      const { allActive, failed } = await checkAssetsActive(provider, assetIds)
      if (failed.length) {
        await persistTerminal(msg.taskId, { status: 'failed', request_payload: payload, response_payload: null, result_urls: [], error_message: '参考素材入库审核未通过（可能含真人/违规内容），已拦截' }, null)
        return null
      }
      if (allActive) {
        return { next: { taskId: msg.taskId, phase: 'submit' }, delaySeconds: 1 }
      }
      if (Date.now() - startedAt > ASSET_INGEST_MAX_MS) {
        await persistTerminal(msg.taskId, { status: 'failed', request_payload: payload, response_payload: null, result_urls: [], error_message: '参考素材入库超时（预处理未在限定时间内完成）' }, null)
        return null
      }
      return { next: { taskId: msg.taskId, phase: 'prepare-assets', startedAt }, delaySeconds: ASSET_INGEST_GAP_S }
    } catch (err: any) {
      await persistTerminal(msg.taskId, { status: 'failed', request_payload: payload, response_payload: null, result_urls: [], error_message: err?.message || '素材库入库失败' }, null)
      return null
    }
  }

  if (msg.phase === 'submit') {
    const sub = await submitAsyncTask({ format, baseUrl: provider.base_url, apiKey, kind, payload })
    if (!sub.ok) {
      await persistTerminal(msg.taskId, { status: 'failed', http_status: sub.http_status, request_payload: payload, response_payload: sub.submitResp, result_urls: [], error_message: sub.error_message }, null)
      return null
    }
    // 落库 submit 响应 + remote_task_id（UI 响应 tab 立即可见）。
    try {
      await db.prepare('UPDATE tasks SET response_payload = ?, remote_task_id = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(JSON.stringify({ submit: sub.submitResp, poll_url: sub.pollUrl, polls: [] }), sub.taskId || null, Date.now(), msg.taskId, row.user_id)
    } catch (err) { console.error(`[taskrunner] submit persist #${msg.taskId}:`, err) }
    return { next: { taskId: msg.taskId, phase: 'poll', startedAt: Date.now(), pollUrl: sub.pollUrl }, delaySeconds: gapSecFor(kind) }
  }

  // phase === 'poll'
  const startedAt = msg.startedAt || Date.now()
  const pollUrl = msg.pollUrl
  if (!pollUrl) {  // 异常：poll 消息缺 pollUrl，退回 submit 重来
    return { next: { taskId: msg.taskId, phase: 'submit' }, delaySeconds: 1 }
  }
  const outcome = await pollAsyncOnce({ format, apiKey, pollUrl })
  if (outcome.kind === 'done') {
    await persistTerminal(msg.taskId, {
      ...outcome.result,
      remote_task_id: row.remote_task_id || undefined,
      response_payload: { poll_url: pollUrl, polls: [outcome.poll] },
    }, Date.now() - startedAt, kind)
    return null
  }
  if (outcome.kind === 'error') {
    await persistTerminal(msg.taskId, { ...outcome.result, remote_task_id: row.remote_task_id || undefined }, Date.now() - startedAt)
    return null
  }
  // continue / transient：未终态。超 maxMs 则判超时失败，否则带 delay 再轮询。
  if (Date.now() - startedAt > maxMsFor(kind)) {
    await persistTerminal(msg.taskId, {
      status: 'failed', request_payload: payload,
      response_payload: { poll_url: pollUrl, polls: outcome.kind === 'continue' ? [outcome.poll] : [] },
      result_urls: [], remote_task_id: row.remote_task_id || undefined,
      error_message: `轮询超时 (>${Math.round(maxMsFor(kind) / 60000)} 分钟)`,
    }, Date.now() - startedAt)
    return null
  }
  return { next: { taskId: msg.taskId, phase: 'poll', startedAt, pollUrl }, delaySeconds: gapSecFor(kind) }
}
