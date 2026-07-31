import type { ApiFormat, ModelKind } from '~~/types/api'

export interface ReferenceAsset {
  kind: 'image' | 'video' | 'audio'
  public_url: string  // absolute http(s) URL reachable by the provider
  data_url?: string   // optional base64 fallback when provider can't reach public_url
  asset_id?: string   // db assets.id — 供 Seedance 素材库入库缓存（进程内路径用）
}

// Ordered prompt content from the rich-text editor: text runs interleaved with
// inline @-mention reference assets (e.g. "image1 wearing image2's clothes").
// When present, drives ordered multimodal content[] assembly.
export type OrderedSegment =
  | { type: 'text'; text: string }
  | { type: 'ref'; asset: ReferenceAsset }

export interface AdapterContext {
  baseUrl: string
  apiKey: string
  modelId: string
  kind: ModelKind
  prompt: string
  params: Record<string, unknown>
  refs?: {
    image: ReferenceAsset[]
    video: ReferenceAsset[]
    audio: ReferenceAsset[]
  }
  // Ordered text+ref segments (rich-text @ mentions). Takes precedence over
  // `refs` for content[] assembly when present.
  segments?: OrderedSegment[]
  // Optional progress hook. Async adapters fire this with the create/submit
  // response as soon as it lands (before polling starts), so callers can
  // persist a partial response_payload immediately and the UI can render it.
  onCreated?: (payload: { remote_task_id?: string; response_payload: unknown }) => void | Promise<void>
}

export interface AdapterResult {
  status: 'succeeded' | 'failed'
  http_status?: number
  request_payload: unknown
  response_payload: unknown
  result_urls: string[]
  result_text?: string
  remote_task_id?: string
  error_message?: string
}

const TERMINAL_VIDEO = new Set(['succeeded', 'failed', 'cancelled', 'expired'])
const SUCCESS_STATUSES = new Set(['succeeded', 'success', 'completed', 'finished', 'done', 'ok'])
const FAILURE_STATUSES = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'expired', 'timeout'])

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function extractError(err: any): { http_status?: number; message: string; data?: unknown } {
  const http_status = err?.response?.status || err?.statusCode
  const data = err?.data || err?.response?._data
  const message
    = data?.error?.message
    || data?.message
    || data?.error
    || err?.statusMessage
    || err?.message
    || 'Request failed'
  return { http_status, message: String(message), data }
}

// Per-request timeouts. Without these a hung upstream connection blocks the
// `await $fetch` forever, so the poll loop never reaches its maxMs check and the
// task is stuck at running until the next server restart (orphan reclaim).
const SUBMIT_TIMEOUT_MS = 60 * 1000   // one-shot create/submit POST
const SYNC_TIMEOUT_MS = 5 * 60 * 1000 // sync generation can legitimately be slow
const POLL_TIMEOUT_MS = 30 * 1000     // single poll GET

// Overall poll ceiling, differentiated by kind: an image generation that hasn't
// finished in a few minutes is almost certainly dead, whereas video legitimately
// takes minutes. openai-async serves both kinds, so it picks by ctx.kind; any
// non-video kind (image / text / unknown) uses the image ceiling.
const IMAGE_MAX_MS = 5 * 60 * 1000
const VIDEO_MAX_MS = 10 * 60 * 1000
function maxPollMs(kind: ModelKind): number {
  return kind === 'video' ? VIDEO_MAX_MS : IMAGE_MAX_MS
}

// Poll interval by ceiling: video polls slower (5s) since it runs for minutes;
// image/other poll faster (2s) to surface quick results promptly.
const VIDEO_POLL_GAP_MS = 5000
const IMAGE_POLL_GAP_MS = 2000
function pollGapMs(maxMs: number): number {
  return maxMs === VIDEO_MAX_MS ? VIDEO_POLL_GAP_MS : IMAGE_POLL_GAP_MS
}

// A transient error (request timeout / dropped connection) carries no HTTP
// status — the upstream never answered. Inside a poll loop these should NOT
// kill the task: we swallow them and let the loop retry until maxMs caps it.
// An error WITH an http_status is the upstream explicitly rejecting → terminal.
function isTransientError(err: any): boolean {
  if (extractError(err).http_status) return false
  const name = String(err?.name || '')
  const msg = String(err?.message || '').toLowerCase()
  return /abort|timeout/i.test(name) || /abort|timed?\s?out|timeout|network|fetch failed|econn|socket/.test(msg)
}

function pickUrlsFromObject(obj: any): string[] {
  const urls: string[] = []
  const visit = (v: any) => {
    if (v == null) return
    if (typeof v === 'string') {
      if (/^https?:\/\//i.test(v) && /\.(png|jpe?g|webp|gif|bmp|mp4|mov|webm|m3u8)(\?|$)/i.test(v)) {
        urls.push(v)
      }
      return
    }
    if (Array.isArray(v)) { v.forEach(visit); return }
    if (typeof v === 'object') {
      for (const k of ['url', 'image_url', 'video_url', 'output_url', 'result_url']) {
        if (typeof v[k] === 'string' && /^https?:\/\//i.test(v[k])) urls.push(v[k])
        else if (v[k] && typeof v[k] === 'object' && typeof v[k].url === 'string') urls.push(v[k].url)
      }
      if (typeof v.b64_json === 'string' && v.b64_json.length > 0) urls.push(`data:image/png;base64,${v.b64_json}`)
      for (const k of Object.keys(v)) {
        if (['url', 'image_url', 'video_url', 'output_url', 'result_url', 'b64_json'].includes(k)) continue
        visit(v[k])
      }
    }
  }
  visit(obj)
  return Array.from(new Set(urls))
}

function resourcePath(kind: ModelKind) {
  return kind === 'image' ? 'images' : 'videos'
}

function isLocalHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(:\d+)?$/i.test(host)
}

// Pick a URL the provider can actually fetch:
// - if public_url is an absolute http(s) URL on a non-local host → use it
// - otherwise fall back to inline data: URL (uploaded files when running on localhost)
function pickRefUrl(r: ReferenceAsset): string | null {
  const pub = r.public_url
  if (pub) {
    try {
      const u = new URL(pub)
      if (!isLocalHost(u.host)) return pub
    } catch { /* not absolute */ }
  }
  return r.data_url || null
}

// For OpenAI-style image endpoints (gpt-image-2 etc.), reference images flow
// through the `image` field as a single string or array of strings.
function collectImageRefs(ctx: AdapterContext): string[] {
  // Prefer ordered segments (preserves @-mention order); fall back to refs.
  if (ctx.segments?.length) {
    return ctx.segments
      .filter((s): s is { type: 'ref'; asset: ReferenceAsset } => s.type === 'ref' && s.asset.kind === 'image')
      .map((s) => pickRefUrl(s.asset))
      .filter((u): u is string => !!u)
  }
  if (!ctx.refs?.image?.length) return []
  return ctx.refs.image
    .map((r) => pickRefUrl(r))
    .filter((u): u is string => !!u)
}

function refEntry(asset: ReferenceAsset): Record<string, unknown> | null {
  const url = pickRefUrl(asset)
  if (!url) return null
  if (asset.kind === 'image') return { type: 'image_url', role: 'reference_image', image_url: { url } }
  if (asset.kind === 'video') return { type: 'video_url', role: 'reference_video', video_url: { url } }
  return { type: 'audio_url', role: 'reference_audio', audio_url: { url } }
}

// Build Doubao/Seedance content[] — ordered segments take precedence (text and
// @-mention refs interleaved in document order), else prompt-text-then-refs.
function buildDoubaoContent(ctx: AdapterContext): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = []
  if (ctx.segments?.length) {
    for (const seg of ctx.segments) {
      if (seg.type === 'text') {
        const t = seg.text.replace(/￼/g, '').trim()  // strip chip placeholder chars
        if (t) content.push({ type: 'text', text: t })
      } else {
        const e = refEntry(seg.asset)
        if (e) content.push(e)
      }
    }
    if (content.length) return content
  }
  if (ctx.prompt) content.push({ type: 'text', text: ctx.prompt })
  if (ctx.refs) {
    for (const r of ctx.refs.image) { const e = refEntry(r); if (e) content.push(e) }
    for (const r of ctx.refs.video) { const e = refEntry(r); if (e) content.push(e) }
    for (const r of ctx.refs.audio) { const e = refEntry(r); if (e) content.push(e) }
  }
  return content
}

// 把 doubao content[] 里参考素材的原始 URL 换成 asset://<id>（Seedance 虚拟人像库引用）。
// 命中 urlToAssetId 的 image_url/video_url/audio_url.url 就地替换；已是 asset:// 或未命中的原样。
// 幂等：队列 prepare-assets 阶段可能重复调用（重排轮询时），不会二次替换。
export function rewriteContentToAssetUris(
  content: Record<string, unknown>[],
  urlToAssetId: Map<string, string>,
): Record<string, unknown>[] {
  return content.map((item) => {
    for (const field of ['image_url', 'video_url', 'audio_url'] as const) {
      const holder = item[field] as { url?: string } | undefined
      const url = holder?.url
      if (typeof url === 'string' && !url.startsWith('asset://') && urlToAssetId.has(url)) {
        return { ...item, [field]: { ...holder, url: `asset://${urlToAssetId.get(url)}` } }
      }
    }
    return item
  })
}

async function runOpenAISync(ctx: AdapterContext): Promise<AdapterResult> {
  const cleanParams = { ...ctx.params }
  // UI-only helpers — provider doesn't understand these. `size` is the canonical key.
  delete (cleanParams as any).ratio
  delete (cleanParams as any).image_resolution
  const refImages = collectImageRefs(ctx)
  const payload: Record<string, unknown> = {
    model: ctx.modelId,
    prompt: ctx.prompt,
    ...cleanParams,
    ...(refImages.length ? { image: refImages.length === 1 ? refImages[0] : refImages } : {}),
  }
  return runPreparedSyncTask({ format: 'openai-sync', baseUrl: ctx.baseUrl, apiKey: ctx.apiKey, kind: ctx.kind, payload })
}

// xAI Imagine uses two JSON endpoints under one model family: text-to-image goes
// to /images/generations, while any reference image switches to /images/edits.
// This differs from the generic OpenAI-compatible adapter, which always posts to
// /generations and sends image references as strings.
async function runXAIImageSync(ctx: AdapterContext): Promise<AdapterResult> {
  const payload = buildRequestPayload('xai-image', ctx)
  return runPreparedSyncTask({ format: 'xai-image', baseUrl: ctx.baseUrl, apiKey: ctx.apiKey, kind: ctx.kind, payload })
}

// Shared async-task poll loop. Both async adapters (openai-async, doubao-video)
// submit a job, get a task id, then GET a poll URL until a terminal state. Only
// the submit step, poll URL, and how a single poll response is interpreted
// differ — everything else (per-poll timeout, transient-retry, maxMs ceiling,
// poll interval, response_payload assembly) is identical and lives here so the
// timeout policy has one home.
//
// `interpret(data)` inspects one poll response and returns:
//   - { done: true, result }  → terminal; `result` completes the AdapterResult
//   - { done: false }         → still running, keep polling
// `wrap(polls)` builds the response_payload for the current poll snapshot, so
// each adapter keeps its own shape ({ submit, ... } vs { create, ... }).
// ── 单次轮询判读（供进程内循环与队列消费者共用）──────────────────────────────
// 两个异步协议判读一次 poll 响应的逻辑抽成纯函数（无网络），队列消费者据 api_format 选用。
export function interpretPoll(
  format: ApiFormat,
  data: any,
): { done: true; result: Partial<AdapterResult> } | { done: false } {
  if (format === 'doubao-video') return interpretDoubaoVideo(data)
  return interpretOpenAIAsync(data)
}

function interpretOpenAIAsync(data: any): { done: true; result: Partial<AdapterResult> } | { done: false } {
  const inner = (data && typeof data.data === 'object') ? data.data : data
  const statusRaw = String(
    inner?.status ?? inner?.state ?? inner?.task_status ?? data?.status ?? '',
  ).toLowerCase()
  if (SUCCESS_STATUSES.has(statusRaw)) {
    const urls = pickUrlsFromObject(inner)
    return { done: true, result: {
      status: urls.length ? 'succeeded' : 'failed',
      result_urls: urls,
      error_message: urls.length ? undefined : '任务完成但未能解析出结果 URL',
    } }
  }
  if (FAILURE_STATUSES.has(statusRaw)) {
    return { done: true, result: {
      status: 'failed',
      error_message: inner?.error?.message || inner?.message || inner?.fail_reason || data?.message || `任务 ${statusRaw}`,
    } }
  }
  if (!statusRaw) {
    const urls = pickUrlsFromObject(inner)
    if (urls.length) return { done: true, result: { status: 'succeeded', result_urls: urls } }
  }
  return { done: false }
}

function interpretDoubaoVideo(data: any): { done: true; result: Partial<AdapterResult> } | { done: false } {
  const status: string = data?.status || 'running'
  if (!TERMINAL_VIDEO.has(status)) return { done: false }
  if (status === 'succeeded') {
    const videoUrl: string | undefined = data?.content?.video_url
    return { done: true, result: {
      status: 'succeeded',
      result_urls: videoUrl ? [videoUrl] : [],
      error_message: videoUrl ? undefined : '任务已完成但响应中未发现视频 URL',
    } }
  }
  return { done: true, result: {
    status: 'failed',
    error_message: data?.error?.message || `任务 ${status}`,
  } }
}

interface PollConfig {
  ctx: AdapterContext
  taskId: string
  pollUrl: string
  payload: unknown
  maxMs: number
  wrap: (polls: any[], extra?: Record<string, unknown>) => Record<string, unknown>
  interpret: (data: any) => { done: true; result: Partial<AdapterResult> } | { done: false }
}

// 单次轮询：GET 一次上游状态并判读。返回 done(终态，附结果) / continue(继续) /
// error(上游明确报错，终态) / transient(瞬时错误，应重试)。队列消费者与进程内循环共用。
export type PollOnceOutcome =
  | { kind: 'done'; result: AdapterResult; poll: any }
  | { kind: 'continue'; poll: any }
  | { kind: 'error'; result: AdapterResult }
  | { kind: 'transient' }

async function pollOnce(cfg: Omit<PollConfig, 'maxMs'>): Promise<PollOnceOutcome> {
  const { ctx, taskId, pollUrl, payload, wrap, interpret } = cfg
  try {
    const data: any = await $fetch(pollUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${ctx.apiKey}` },
      timeout: POLL_TIMEOUT_MS,
    })
    const verdict = interpret(data)
    if (verdict.done) {
      return { kind: 'done', poll: data, result: {
        remote_task_id: taskId,
        request_payload: payload,
        response_payload: wrap([data]),
        result_urls: [],
        ...verdict.result,
      } as AdapterResult }
    }
    return { kind: 'continue', poll: data }
  } catch (err: any) {
    // 瞬时错误（超时/断连，无 http_status）：不杀任务，让调用方按 maxMs 兜底重试。
    if (isTransientError(err)) return { kind: 'transient' }
    const e = extractError(err)
    return { kind: 'error', result: {
      status: 'failed',
      http_status: e.http_status,
      remote_task_id: taskId,
      request_payload: payload,
      response_payload: wrap([], { poll_error: e.data ?? null }),
      result_urls: [],
      error_message: `轮询失败: ${e.message}`,
    } }
  }
}

async function pollUntilTerminal(cfg: PollConfig): Promise<AdapterResult> {
  const { ctx, maxMs, wrap } = cfg
  const startedAt = Date.now()
  const gap = pollGapMs(maxMs)

  while (true) {
    const outcome = await pollOnce(cfg)
    if (outcome.kind === 'done' || outcome.kind === 'error') return outcome.result
    // continue / transient：都到 maxMs 上限判断后再睡一觉重试。
    if (Date.now() - startedAt > maxMs) break
    await new Promise((r) => setTimeout(r, gap))
  }

  return {
    status: 'failed',
    remote_task_id: cfg.taskId,
    request_payload: cfg.payload,
    response_payload: wrap([]),
    result_urls: [],
    error_message: `轮询超时 (>${Math.round(maxMs / 60000)} 分钟)`,
  }
}

async function runOpenAIAsync(ctx: AdapterContext): Promise<AdapterResult> {
  const resource = resourcePath(ctx.kind)
  const submitPathBase = `${resource}/generations`
  const taskPath = (id: string) => `${resource}/tasks/${encodeURIComponent(id)}`

  const webhook = ctx.params.webhook ? String(ctx.params.webhook) : null
  const extra: Record<string, unknown> = { ...ctx.params }
  delete extra.webhook
  // UI-only helpers when kind=image — `size` is the canonical key the provider understands
  if (ctx.kind === 'image') {
    delete (extra as any).ratio
    delete (extra as any).image_resolution
  }

  const submitUrl = (() => {
    const u = new URL(joinUrl(ctx.baseUrl, submitPathBase))
    u.searchParams.set('async', 'true')
    if (webhook) u.searchParams.set('webhook', webhook)
    return u.toString()
  })()

  const refImages = ctx.kind === 'image' ? collectImageRefs(ctx) : []
  const payload: Record<string, unknown> = {
    model: ctx.modelId,
    prompt: ctx.prompt,
    ...extra,
    ...(refImages.length ? { image: refImages.length === 1 ? refImages[0] : refImages } : {}),
  }

  let submitResp: any
  try {
    submitResp = await $fetch<any>(submitUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.apiKey}`,
      },
      body: payload,
      timeout: SUBMIT_TIMEOUT_MS,
    })
  } catch (err: any) {
    const e = extractError(err)
    return {
      status: 'failed',
      http_status: e.http_status,
      request_payload: payload,
      response_payload: e.data ?? null,
      result_urls: [],
      error_message: e.message,
    }
  }

  const taskId: string | undefined
    = typeof submitResp?.data === 'string' ? submitResp.data
    : submitResp?.data?.task_id || submitResp?.data?.id
    || submitResp?.task_id || submitResp?.id
  if (!taskId) {
    return {
      status: 'failed',
      request_payload: payload,
      response_payload: submitResp,
      result_urls: [],
      error_message: '提交任务后未返回 task_id',
    }
  }

  const pollUrl = joinUrl(ctx.baseUrl, taskPath(taskId))
  const wrap = (polls: any[], extra?: Record<string, unknown>) =>
    ({ submit: submitResp, poll_url: pollUrl, polls, ...extra })

  // Surface the submit response immediately so the UI's 响应 tab is populated
  // before any poll completes.
  await ctx.onCreated?.({ remote_task_id: taskId, response_payload: wrap([]) })

  return pollUntilTerminal({
    ctx, taskId, pollUrl, payload, maxMs: maxPollMs(ctx.kind), wrap,
    interpret: interpretOpenAIAsync,
  })
}

async function runDoubaoVideo(ctx: AdapterContext): Promise<AdapterResult> {
  const createUrl = joinUrl(ctx.baseUrl, 'contents/generations/tasks')

  const ratio = (ctx.params.ratio as string) || '9:16'
  const resolution = (ctx.params.resolution as string) || '480p'
  const duration = Number(ctx.params.duration) || 6
  const generate_audio = ctx.params.generate_audio !== undefined ? !!ctx.params.generate_audio : true
  const watermark = !!ctx.params.watermark
  const extra = { ...ctx.params }
  // use_asset_library 是内部标志（是否把参考素材走 Seedance 素材库），不外发上游。
  for (const k of ['ratio', 'resolution', 'duration', 'generate_audio', 'watermark', 'seed', 'return_last_frame', 'use_asset_library']) {
    delete (extra as any)[k]
  }

  // Assemble multimodal content[] — ordered @-mention segments interleave text
  // and refs; otherwise prompt-then-refs. (commit 277f351 shape).
  const content = buildDoubaoContent(ctx)

  const payload: Record<string, unknown> = {
    model: ctx.modelId,
    content,
    ratio,
    resolution,
    duration,
    generate_audio,
    watermark,
    ...extra,
  }

  let createResp: any
  try {
    createResp = await $fetch<any>(createUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.apiKey}`,
      },
      body: payload,
      timeout: SUBMIT_TIMEOUT_MS,
    })
  } catch (err: any) {
    const e = extractError(err)
    return {
      status: 'failed',
      http_status: e.http_status,
      request_payload: payload,
      response_payload: e.data ?? null,
      result_urls: [],
      error_message: e.message,
    }
  }

  const taskId: string | undefined = createResp?.id || createResp?.task_id || createResp?.data?.id
  if (!taskId) {
    return {
      status: 'failed',
      request_payload: payload,
      response_payload: createResp,
      result_urls: [],
      error_message: '创建任务后未返回任务 ID',
    }
  }

  const pollUrl = joinUrl(ctx.baseUrl, `contents/generations/tasks/${encodeURIComponent(taskId)}`)
  const wrap = (polls: any[], extra?: Record<string, unknown>) =>
    ({ create: createResp, poll_url: pollUrl, polls, ...extra })

  // Surface the create response immediately so the UI's 响应 tab populates
  // before the first poll completes.
  await ctx.onCreated?.({ remote_task_id: taskId, response_payload: wrap([]) })

  return pollUntilTerminal({
    ctx, taskId, pollUrl, payload, maxMs: VIDEO_MAX_MS, wrap,
    interpret: interpretDoubaoVideo,
  })
}

export function adapterLabel(format: ApiFormat): string {
  if (format === 'openai-sync') return 'OpenAI 兼容 · 同步'
  if (format === 'openai-async') return 'OpenAI 兼容 · 异步'
  if (format === 'xai-image') return 'xAI Imagine · 图片'
  if (format === 'doubao-video') return 'Doubao / Seedance · 视频'
  return format
}

// ── 队列消费者驱动的「提交」与「单次轮询」（Cloudflare Queues 路径）──────────────
// 进程内 runOpenAIAsync/runDoubaoVideo 把提交+轮询串在一个长活函数里；Workers 上
// 单次请求活不了这么久（视频轮询上限 10min），故拆成两个无状态原语：消费者每条消息
// 只做一步，未终态就带 delay 重新入队。二者复用上面的 interpretPoll / URL 约定，逻辑与进程内路径一致。

export interface SubmitResult {
  ok: boolean
  taskId?: string
  pollUrl?: string
  submitResp: unknown
  http_status?: number
  error_message?: string
}

// 提交异步任务（消费者 submit 阶段）：POST 已落库的 request_payload，解析出 taskId 与
// 轮询 URL。format 必须是异步协议（openai-async / doubao-video）。
export async function submitAsyncTask(opts: {
  format: ApiFormat
  baseUrl: string
  apiKey: string
  kind: ModelKind
  payload: Record<string, unknown>
}): Promise<SubmitResult> {
  const { format, baseUrl, apiKey, kind, payload } = opts
  const submitUrl = format === 'doubao-video'
    ? joinUrl(baseUrl, 'contents/generations/tasks')
    : (() => {
        const u = new URL(joinUrl(baseUrl, `${resourcePath(kind)}/generations`))
        u.searchParams.set('async', 'true')
        if (payload.webhook) u.searchParams.set('webhook', String(payload.webhook))
        return u.toString()
      })()
  let resp: any
  try {
    resp = await $fetch<any>(submitUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: payload,
      timeout: SUBMIT_TIMEOUT_MS,
    })
  } catch (err: any) {
    const e = extractError(err)
    return { ok: false, submitResp: e.data ?? null, http_status: e.http_status, error_message: e.message }
  }
  const taskId: string | undefined = format === 'doubao-video'
    ? (resp?.id || resp?.task_id || resp?.data?.id)
    : (typeof resp?.data === 'string' ? resp.data : resp?.data?.task_id || resp?.data?.id || resp?.task_id || resp?.id)
  if (!taskId) {
    return { ok: false, submitResp: resp, error_message: format === 'doubao-video' ? '创建任务后未返回任务 ID' : '提交任务后未返回 task_id' }
  }
  const pollUrl = format === 'doubao-video'
    ? joinUrl(baseUrl, `contents/generations/tasks/${encodeURIComponent(taskId)}`)
    : joinUrl(baseUrl, `${resourcePath(kind)}/tasks/${encodeURIComponent(taskId)}`)
  return { ok: true, taskId, pollUrl, submitResp: resp }
}

// 单次轮询（消费者 poll 阶段）：GET 一次 pollUrl 并按 format 判读。
export async function pollAsyncOnce(opts: {
  format: ApiFormat
  apiKey: string
  pollUrl: string
}): Promise<PollOnceOutcome> {
  const { format, apiKey, pollUrl } = opts
  try {
    const data: any = await $fetch(pollUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: POLL_TIMEOUT_MS,
    })
    const verdict = interpretPoll(format, data)
    if (verdict.done) {
      return { kind: 'done', poll: data, result: {
        request_payload: null,
        response_payload: null,
        result_urls: [],
        ...verdict.result,
      } as AdapterResult }
    }
    return { kind: 'continue', poll: data }
  } catch (err: any) {
    if (isTransientError(err)) return { kind: 'transient' }
    const e = extractError(err)
    return { kind: 'error', result: {
      status: 'failed',
      http_status: e.http_status,
      request_payload: null,
      response_payload: e.data ?? null,
      result_urls: [],
      error_message: `轮询失败: ${e.message}`,
    } }
  }
}

// Build the request payload synchronously, without making any network call.
// Used by /api/tasks/run to persist `request_payload` immediately so the UI's
// 请求 tab is populated before the upstream call completes.
export function buildRequestPayload(format: ApiFormat, ctx: AdapterContext): Record<string, unknown> {
  // Text models always use the chat/completions request shape, regardless of the
  // provider's image/video api_format. Queue consumers execute this exact persisted
  // payload, so building `messages` here avoids sending an image-style `prompt` body.
  if (ctx.kind === 'text') {
    return {
      model: ctx.modelId,
      messages: [{ role: 'user', content: ctx.prompt }],
      ...ctx.params,
    }
  }
  if (format === 'doubao-video') {
    const ratio = (ctx.params.ratio as string) || '9:16'
    const resolution = (ctx.params.resolution as string) || '480p'
    const duration = Number(ctx.params.duration) || 6
    const generate_audio = ctx.params.generate_audio !== undefined ? !!ctx.params.generate_audio : true
    const watermark = !!ctx.params.watermark
    const extra = { ...ctx.params }
    for (const k of ['ratio', 'resolution', 'duration', 'generate_audio', 'watermark', 'seed', 'return_last_frame', 'use_asset_library']) {
      delete (extra as any)[k]
    }
    const content = buildDoubaoContent(ctx)
    return { model: ctx.modelId, content, ratio, resolution, duration, generate_audio, watermark, ...extra }
  }
  if (format === 'xai-image') {
    const cleanParams = { ...ctx.params }
    const refImages = collectImageRefs(ctx).slice(0, 3)

    // Normalize values that may have survived in the per-kind localStorage from
    // another image provider. xAI expects aspect_ratio + lowercase 1k/2k, not
    // the generic UI's ratio/image_resolution/size helper keys.
    const aspectRatio = String(cleanParams.aspect_ratio ?? cleanParams.ratio ?? 'auto')
    const rawResolution = String(cleanParams.resolution ?? cleanParams.image_resolution ?? '1k').toLowerCase()
    const resolution = rawResolution === '2k' ? '2k' : '1k'
    for (const k of ['aspect_ratio', 'ratio', 'resolution', 'image_resolution', 'size', 'image', 'images']) {
      delete (cleanParams as any)[k]
    }

    const imagePayload = refImages.length === 1
      ? { image: { url: refImages[0], type: 'image_url' } }
      : refImages.length > 1
        ? { images: refImages.map((url) => ({ url, type: 'image_url' })) }
        : {}
    // For edits, omitting an automatic aspect ratio preserves xAI's documented
    // default: follow the first source image. Text-to-image may send `auto`.
    const aspectRatioPayload = refImages.length && aspectRatio === 'auto'
      ? {}
      : { aspect_ratio: aspectRatio }
    return {
      model: ctx.modelId,
      prompt: ctx.prompt,
      ...cleanParams,
      ...aspectRatioPayload,
      resolution,
      ...imagePayload,
    }
  }

  // openai-sync / openai-async (image or video kind)
  const cleanParams = { ...ctx.params }
  delete (cleanParams as any).ratio
  delete (cleanParams as any).image_resolution
  if (format === 'openai-async') delete (cleanParams as any).webhook
  const refImages = ctx.kind === 'image' ? collectImageRefs(ctx) : []
  return {
    model: ctx.modelId,
    prompt: ctx.prompt,
    ...cleanParams,
    ...(refImages.length ? { image: refImages.length === 1 ? refImages[0] : refImages } : {}),
  }
}

export function adapterSupportsKind(format: ApiFormat, kind: ModelKind): boolean {
  if (format === 'doubao-video') return kind === 'video'
  if (format === 'xai-image') return kind === 'image'
  return true
}

export async function runAdapter(format: ApiFormat, ctx: AdapterContext): Promise<AdapterResult> {
  // Text/chat models (e.g. gpt-5.5) use /chat/completions regardless of the
  // provider's image/video api_format.
  if (ctx.kind === 'text') return runChatText(ctx)
  if (!adapterSupportsKind(format, ctx.kind)) {
    throw new Error(`API 协议 ${format} 不支持 ${ctx.kind} 模型`)
  }
  if (format === 'openai-sync') return runOpenAISync(ctx)
  if (format === 'xai-image') return runXAIImageSync(ctx)
  if (format === 'openai-async') return runOpenAIAsync(ctx)
  if (format === 'doubao-video') return runDoubaoVideo(ctx)
  throw new Error(`Unsupported api_format: ${format}`)
}

// Chat/completions adapter — the "result" is the generated text, surfaced via
// result_text so the existing UI can render it.
async function runChatText(ctx: AdapterContext): Promise<AdapterResult> {
  const payload = buildRequestPayload('openai-sync', ctx)
  return runPreparedSyncTask({ format: 'openai-sync', baseUrl: ctx.baseUrl, apiKey: ctx.apiKey, kind: ctx.kind, payload })
}

// Execute the exact request payload persisted on the task row. Queue consumers use
// this path for text/openai-sync/xai-image jobs so the HTTP request can return immediately
// without relying on a five-minute provider call surviving inside waitUntil().
export async function runPreparedSyncTask(ctx: {
  format: ApiFormat
  baseUrl: string
  apiKey: string
  kind: ModelKind
  payload: Record<string, unknown>
}): Promise<AdapterResult> {
  const isText = ctx.kind === 'text'
  const isXAIImage = ctx.format === 'xai-image'
  const isXAIEdit = isXAIImage && (!!ctx.payload.image || Array.isArray(ctx.payload.images))
  const path = isText
    ? 'chat/completions'
    : isXAIImage
      ? (isXAIEdit ? 'images/edits' : 'images/generations')
      : `${resourcePath(ctx.kind)}/generations`
  const url = joinUrl(ctx.baseUrl, path)
  try {
    const resp = await $fetch<any>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
      body: ctx.payload,
      timeout: SYNC_TIMEOUT_MS,
    })
    if (isText) {
      const text = resp?.choices?.[0]?.message?.content ?? ''
      return {
        status: text ? 'succeeded' : 'failed',
        request_payload: ctx.payload,
        response_payload: resp,
        result_urls: [],
        result_text: text,
        error_message: text ? undefined : '响应中没有文本内容',
      }
    }
    const urls = pickUrlsFromObject(resp)
    return {
      status: urls.length ? 'succeeded' : 'failed',
      request_payload: ctx.payload,
      response_payload: resp,
      result_urls: urls,
      error_message: urls.length ? undefined : '响应中未发现结果 URL 或 base64 数据',
    }
  } catch (err: any) {
    const e = extractError(err)
    return {
      status: 'failed',
      http_status: e.http_status,
      request_payload: ctx.payload,
      response_payload: e.data ?? null,
      result_urls: [],
      error_message: e.message,
    }
  }
}
