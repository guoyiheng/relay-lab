/**
 * 离线任务链路（浏览器侧驱动，对齐在线的提交-落库-后台执行-轮询恢复骨架）。
 *
 * 在线：run.post 落库 → startTask 起后台(队列/进程内)轮询 → 前端轮询自己的 DB 恢复。
 * 离线：这里把「后台执行」搬到浏览器——runOfflineTask 插一条 running 行(IndexedDB)后
 * 立即返回，随即在后台调 /api/proxy/generate（同步直接终态；异步拿 pollUrl 后自跑轮询
 * 循环调 /api/proxy/poll），每步写回 IndexedDB。前端 store 轮询自己的 IndexedDB 恢复 UI，
 * 与在线前端轮询 DB 完全同构。刷新丢失的是内存里的轮询循环，靠 resumeOfflineTaskPolls
 * 从持久化的 response_payload.poll_url 重启。
 */
import type { Provider, Model, TaskRow, TaskRunPayload, ModelKind, ApiFormat, PickerAsset } from '~~/types/api'
import { idb } from './idb'

// 超时/间隔与在线一致：视频 10min/5s，其余 5min/2s（见 CLAUDE.md 任务框架）。
const VIDEO_MAX_MS = 10 * 60 * 1000
const IMAGE_MAX_MS = 5 * 60 * 1000
const VIDEO_GAP_MS = 5000
const IMAGE_GAP_MS = 2000
const maxMsFor = (k: ModelKind) => (k === 'video' ? VIDEO_MAX_MS : IMAGE_MAX_MS)
const gapMsFor = (k: ModelKind) => (k === 'video' ? VIDEO_GAP_MS : IMAGE_GAP_MS)
const interruptedTaskTimers = new Map<number, ReturnType<typeof setTimeout>>()

function now() { return Date.now() }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Ref = { kind: 'image' | 'video' | 'audio'; public_url: string }
type RefKind = Ref['kind']
type RefIds = Record<RefKind, string[]>
export type OfflineTaskRecord = TaskRow & { ref_ids?: Partial<RefIds>; deleted_at?: number | null }

function normalizedRefIds(payload: TaskRunPayload): RefIds {
  return {
    image: [...(payload.refs?.image || [])],
    video: [...(payload.refs?.video || [])],
    audio: [...(payload.refs?.audio || [])],
  }
}

export async function hydrateOfflineTask(task: OfflineTaskRecord): Promise<TaskRow> {
  const refs: NonNullable<TaskRow['refs']> = { image: [], video: [], audio: [] }
  for (const kind of ['image', 'video', 'audio'] as const) {
    for (const id of task.ref_ids?.[kind] || []) {
      const asset = await idb.get<PickerAsset>('assets', id)
      if (!asset) continue
      refs[kind].push({
        asset_id: asset.id,
        filename: asset.filename,
        public_url: asset.url,
        mime: asset.mime,
        size: asset.size,
        width: asset.width,
        height: asset.height,
      })
    }
  }
  const { ref_ids: _refIds, deleted_at: _deletedAt, ...row } = task
  return { ...row, refs }
}

// asset id → ReferenceAsset（离线素材 url 已是 data:URL 或 web URL，provider 可拉取/内联）。
async function resolveRefs(payload: TaskRunPayload) {
  const byKind: Record<'image' | 'video' | 'audio', Ref[]> = { image: [], video: [], audio: [] }
  for (const k of ['image', 'video', 'audio'] as const) {
    for (const id of payload.refs?.[k] || []) {
      const a = await idb.get<{ url: string }>('assets', id)
      if (a?.url) byKind[k].push({ kind: k, public_url: a.url })
    }
  }
  let segments: Array<{ type: 'text'; text: string } | { type: 'ref'; asset: Ref }> | undefined
  if (payload.segments?.length) {
    const out: NonNullable<typeof segments> = []
    for (const seg of payload.segments) {
      if (seg.type === 'text') out.push({ type: 'text', text: seg.text })
      else {
        const a = await idb.get<{ url: string }>('assets', seg.upload_id)
        if (a?.url) out.push({ type: 'ref', asset: { kind: seg.kind, public_url: a.url } })
      }
    }
    if (out.some((s) => s.type === 'ref')) segments = out
  }
  return { refs: byKind, segments }
}

// 结果持久化：图片 URL 转 base64 存本机（离线要求）；视频保留远端 URL；data:/文本原样。
async function persistImagesToBase64(urls: string[], kind: ModelKind): Promise<string[]> {
  if (kind !== 'image') return urls
  return Promise.all(urls.map(async (u) => {
    if (u.startsWith('data:')) return u          // b64_json 已是 data URL
    if (!/^https?:\/\//i.test(u)) return u
    try {
      const r = await $fetch<{ dataUrl: string }>('/api/proxy/fetch', { method: 'POST', body: { url: u } })
      return r.dataUrl || u
    } catch { return u }                          // 转存失败保留原 URL（可能已过期，但不丢结果）
  }))
}

async function patchTask(id: number, patch: Partial<TaskRow & { deleted_at?: number | null }>) {
  const cur = await idb.get<TaskRow>('tasks', id)
  if (!cur) return
  await idb.put('tasks', { ...cur, ...patch, updated_at: now() })
}

// 写终态：图片转 base64 后落库（status/结果/耗时/finished_at）。
async function finishTask(id: number, kind: ModelKind, r: {
  status: 'succeeded' | 'failed'
  http_status?: number
  response_payload?: unknown
  result_urls?: string[]
  result_text?: string
  remote_task_id?: string
  error_message?: string
  request_payload?: unknown
}, startedAt: number) {
  const urls = await persistImagesToBase64(r.result_urls || [], kind)
  const finishedAt = now()
  await patchTask(id, {
    status: r.status,
    http_status: r.http_status ?? null,
    latency_ms: finishedAt - startedAt,
    ...(r.request_payload !== undefined ? { request_payload: r.request_payload } : {}),
    response_payload: r.response_payload ?? null,
    result_urls: urls,
    result_text: r.result_text ?? null,
    remote_task_id: r.remote_task_id ?? null,
    error_message: r.error_message ?? null,
    finished_at: finishedAt,
  })
}

// 浏览器侧轮询循环：按 kind 节奏调 /api/proxy/poll 直到终态/超时。startedAt 用于 maxMs 兜底。
async function pollLoop(id: number, format: ApiFormat, kind: ModelKind, apiKey: string, pollUrl: string, startedAt: number) {
  const maxMs = maxMsFor(kind)
  const gap = gapMsFor(kind)
  while (true) {
    // 任务可能已被删除/终态（如用户删了任务）→ 停止循环。
    const cur = await idb.get<TaskRow & { deleted_at?: number | null }>('tasks', id)
    if (!cur || cur.deleted_at || cur.status === 'succeeded' || cur.status === 'failed') return
    let outcome: any
    try {
      outcome = await $fetch('/api/proxy/poll', { method: 'POST', body: { format, apiKey, pollUrl } })
    } catch {
      outcome = { kind: 'transient' }             // 端点/网络抖动，按瞬时错误处理
    }
    if (outcome.kind === 'done') {
      await finishTask(id, kind, {
        ...outcome.result,
        response_payload: { poll_url: pollUrl, polls: [outcome.poll] },
      }, startedAt)
      return
    }
    if (outcome.kind === 'error') {
      await finishTask(id, kind, { ...outcome.result }, startedAt)
      return
    }
    // continue / transient：未终态。超 maxMs 判超时失败，否则睡一觉再来。
    if (now() - startedAt > maxMs) {
      await finishTask(id, kind, {
        status: 'failed',
        response_payload: { poll_url: pollUrl, polls: outcome.kind === 'continue' ? [outcome.poll] : [] },
        error_message: `轮询超时 (>${Math.round(maxMs / 60000)} 分钟)`,
      }, startedAt)
      return
    }
    await sleep(gap)
  }
}

// 后台执行：generate → 同步落终态 / 异步落 submit 响应后起轮询循环。不 await（fire-and-forget）。
async function runInBackground(task: TaskRow, provider: Provider, model: Model, payload: TaskRunPayload) {
  const startedAt = task.created_at
  const { refs, segments } = await resolveRefs(payload)
  const apiKey = resolveModelKeyClient(provider, model)
  const body = {
    format: task.api_format, kind: task.kind, baseUrl: provider.base_url, apiKey,
    modelId: model.model_id, prompt: task.prompt, params: task.params || {}, refs, segments,
  }
  let gen: any
  try {
    gen = await $fetch('/api/proxy/generate', { method: 'POST', body })
  } catch (err: any) {
    await finishTask(task.id, task.kind, {
      status: 'failed',
      request_payload: {
        model: model.model_id,
        prompt: task.prompt,
        ...(task.params || {}),
      },
      error_message: err?.data?.statusMessage || err?.statusMessage || err?.message || '请求失败',
    }, startedAt)
    return
  }
  if (gen.phase === 'terminal') {
    await finishTask(task.id, task.kind, { ...gen.result, request_payload: gen.result?.request_payload }, startedAt)
    return
  }
  // 异步：落 submit 响应 + request_payload（响应/请求 tab 立即可见），再轮询。
  await patchTask(task.id, {
    request_payload: gen.request_payload ?? null,
    response_payload: { submit: gen.submitResp, poll_url: gen.pollUrl, polls: [] },
    remote_task_id: gen.taskId ?? null,
  })
  await pollLoop(task.id, task.api_format, task.kind, apiKey, gen.pollUrl, startedAt)
}

// 模型独立 key 优先，否则用平台 key（对齐 server/utils/llm.resolveModelKey）。
function resolveModelKeyClient(provider: Provider, model: Model): string {
  const first = model.keys?.find((k) => k.enabled !== false && k.key)
  return first?.key || provider.api_key
}

// runTask 入口：校验平台/模型 → 插 running 行 → 后台执行(不 await) → 立即返回行。
export async function runOfflineTask(payload: TaskRunPayload): Promise<TaskRow> {
  const provider = await idb.get<Provider>('providers', payload.provider_id)
  if (!provider) throw new Error('平台不存在')
  if (!provider.enabled) throw new Error('该平台已被禁用')
  const model = await idb.get<Model>('models', payload.model_id)
  if (!model || model.provider_id !== provider.id) throw new Error('模型不存在或不属于所选平台')
  if (!model.enabled) throw new Error('该模型已被禁用')

  const t = now()
  const row = {
    provider_id: provider.id, provider_name: provider.name, provider_base_url: provider.base_url,
    model_id: model.id, model_name: model.display_name || model.model_id,
    kind: model.kind, api_format: provider.api_format,
    prompt: payload.prompt, params: payload.params || {},
    request_payload: null, response_payload: null,
    status: 'running', http_status: null, latency_ms: null, remote_task_id: null,
    result_urls: null, result_text: null, error_message: null, analysis: null, favorite: false,
    // 价格快照（对齐在线：下单冻结当时价）。
    price_mode: model.price_mode, price_cny: model.price_cny,
    price_in_cny: model.price_in_cny, price_out_cny: model.price_out_cny,
    price_novideo_cny: model.price_novideo_cny, price_video_cny: model.price_video_cny,
    created_at: t, updated_at: t, finished_at: null,
    ref_ids: normalizedRefIds(payload),
  } as Omit<TaskRow, 'id'> & { ref_ids: RefIds }
  const id = Number(await idb.add('tasks', row))
  const task = await hydrateOfflineTask({ ...row, id })
  // 后台执行，不阻塞返回——前端拿到 running 行即渲染，随后轮询 IndexedDB 恢复。
  void runInBackground(task, provider, model, payload)
  return task
}

// 刷新后恢复：内存里的轮询循环随页面卸载丢失，这里从持久化状态重启。
//   · running 且有 poll_url → 重启 pollLoop（重解析 key）
//   · running 但无 poll_url（generate 未回来就刷新了）→ 判超时失败，避免永久卡 running
export async function resumeOfflineTaskPolls(tasks: TaskRow[]) {
  for (const t of tasks) {
    if (t.status !== 'running') continue
    const pollUrl = (t.response_payload as any)?.poll_url as string | undefined
    if (!pollUrl) {
      // generate 请求可能仍在同一页面中执行；等到原任务上限后再检查一次，确保即使
      // 用户不再刷新，已中断的任务也会进入失败终态。
      if (interruptedTaskTimers.has(t.id)) continue
      const failIfStillInterrupted = async () => {
        interruptedTaskTimers.delete(t.id)
        const current = await idb.get<TaskRow & { deleted_at?: number | null }>('tasks', t.id)
        if (!current || current.deleted_at || current.status !== 'running') return
        if ((current.response_payload as any)?.poll_url) return
        await patchTask(t.id, {
          status: 'failed',
          error_message: '任务中断（页面刷新且无法恢复）',
          latency_ms: now() - t.created_at,
          finished_at: now(),
        })
      }
      const remaining = maxMsFor(t.kind) - (now() - t.created_at)
      if (remaining <= 0) await failIfStillInterrupted()
      else interruptedTaskTimers.set(t.id, setTimeout(() => { void failIfStillInterrupted() }, remaining))
      continue
    }
    const provider = t.provider_id ? await idb.get<Provider>('providers', t.provider_id) : null
    const model = t.model_id ? await idb.get<Model>('models', t.model_id) : null
    if (!provider || !model) {
      await patchTask(t.id, { status: 'failed', error_message: '平台或模型已删除，任务终止', finished_at: now() })
      continue
    }
    const apiKey = resolveModelKeyClient(provider, model)
    void pollLoop(t.id, t.api_format, t.kind, apiKey, pollUrl, t.created_at)
  }
}
