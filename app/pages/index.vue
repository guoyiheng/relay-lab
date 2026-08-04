<script setup lang="ts">
// 首页混音台（三列）：左=创作（选平台/模型 + 提示词 + 参数），中=结果预览，
// 右=任务列表。提交一条测试 → POST /api/tasks/run，前端轮询 store 恢复状态。
// 参数/参考素材按 kind 存 localStorage，切平台复用、跨 kind 各自恢复。
import type { Provider, Model, TaskRow, ApiFormat, ModelKind, PromptSegment } from '~~/types/api'
import { useProvidersStore } from '~/stores/providers'
import { useTasksStore } from '~/stores/tasks'
import { trackButtonClick } from '~/composables/useAnalytics'

interface ProviderWithModels extends Provider {
  models: Model[]
}

// Pinia stores — cached across route navigations so switching to / providers
// or / history and back doesn't trigger a refetch.
const providersStore = useProvidersStore()
const tasksStore = useTasksStore()
const notify = useNotify()
const confirm = useConfirm()
const { open: openFullscreen } = useFullscreenViewer()
// 混音台平台顺序统一按名称排序（#5）。全量列表（含停用）——历史任务的成本/模型解析仍需查停用平台。
const providers = computed(() => providersStore.byName as ProviderWithModels[])
// 平台选择器只展示启用的平台（停用的自动过滤，不在混音台露出）。
const visibleProviders = computed(() => providers.value.filter((p) => p.enabled))
const tasks = computed(() => tasksStore.tasks)
const activeId = ref<number | null>(null)
const submitting = ref(false)
const polishing = ref(false)
const errorBanner = ref<string | null>(null)
const customPolishCommand = ref('')

const selectedProviderId = ref<number | null>(null)
const selectedModelId = ref<number | null>(null)
const prompt = ref('')
const promptEditorRef = ref<{ restoreContent: (text: string, refs: any) => void } | null>(null)
// Ordered prompt content (text runs + inline @-mention chips). Source of truth
// for multimodal interleaving sent to the model. Mirrors `prompt` (the readable
// string) but carries ref signatures in document order.
const promptSegments = ref<PromptSegment[]>([])
const promptFocused = ref(false)

type ParamMode = 'form' | 'json'
const paramMode = ref<ParamMode>('form')
const formParams = ref<Record<string, unknown>>({})
const jsonParamsText = ref('')
const jsonParamsError = ref<string | null>(null)

interface UploadItem {
  id: string
  kind: 'image' | 'video' | 'audio'
  filename: string | null
  public_url: string
  file?: File
  pending?: boolean
  sig?: string
}
const refs = ref<{ image: UploadItem[]; video: UploadItem[]; audio: UploadItem[] }>({
  image: [],
  video: [],
  audio: [],
})

function clearRefs() {
  refs.value = { image: [], video: [], audio: [] }
}

// Flat list of all current refs (for the prompt-box chip row).
const allRefItems = computed<UploadItem[]>(() => [
  ...refs.value.image, ...refs.value.video, ...refs.value.audio,
])
type DetailTab = 'preview' | 'overview' | 'network'
const detailTab = ref<DetailTab>('preview')

const detailTabItems = [
  { slot: 'preview', label: '预览' },
  { slot: 'overview', label: '概览' },
  { slot: 'network', label: '网络' },
]

const selectedProvider = computed(
  () => providers.value.find((p) => p.id === selectedProviderId.value) || null,
)
const availableModels = computed(() =>
  selectedProvider.value?.models.filter((m) => m.enabled) || [],
)
const selectedModel = computed(
  () => availableModels.value.find((m) => m.id === selectedModelId.value) || null,
)
const apiFormat = computed<ApiFormat | null>(() => selectedProvider.value?.api_format ?? null)
const kind = computed<ModelKind | null>(() => selectedModel.value?.kind ?? null)

const activeTask = computed(() => tasksStore.detailById(activeId.value) || tasks.value.find((t) => t.id === activeId.value) || null)

function selectTask(id: number) {
  activeId.value = id
  detailTab.value = 'preview'
}

// List/poll responses omit request/response payloads. Hydrate the complete row
// whenever a detail tab needs it; this also covers a freshly submitted task
// whose initial payload was later followed by a lightweight polling summary.
watch([activeId, detailTab], ([id, tab]) => {
  if (!id || tab === 'preview' || tasksStore.detailById(id)?.refs !== undefined) return
  void tasksStore.loadDetail(id).catch((err: any) => {
    notify.error(err?.data?.statusMessage || err?.statusMessage || err?.message || '任务详情加载失败，请稍后重试')
  })
})

// 润色需要一个启用的、被标记为润色用途的文本模型（在某个启用平台下）。
const hasPolishModel = computed(() =>
  providers.value.some((p) => p.enabled && p.models.some((m) => m.enabled && (m as any).polish_model)),
)

// Reference-asset limits for the current model/format — mirrors ParamsForm.
// Drives the prompt @-mention filter (allowKinds) and the pick guard.
const refLimits = computed(() => {
  if (apiFormat.value === 'doubao-video' && kind.value === 'video') return { image: 9, video: 3, audio: 3 }
  if (apiFormat.value === 'xai-image' && kind.value === 'image') return { image: 3, video: 0, audio: 0 }
  if ((apiFormat.value === 'openai-sync' || apiFormat.value === 'openai-async' || apiFormat.value === 'full-url') && kind.value === 'image') return { image: 4, video: 0, audio: 0 }
  return { image: 0, video: 0, audio: 0 }
})
const allowKinds = computed(() =>
  (['image', 'video', 'audio'] as const).filter((k) => refLimits.value[k] > 0),
)

// @ mention picks an asset → add to refs. Both local & generated assets now
// carry a real asset id (统一 assets 表), so a generated result reused as a
// reference is referenced by its id directly — no re-download/re-import.
// Dedup by signature so the same asset can't be added twice.
function addMentionedAsset(asset: { source: string; id: string; kind: 'image' | 'video' | 'audio'; url: string; filename: string | null }) {
  const k = asset.kind
  if (refLimits.value[k] === 0) return
  if (refs.value[k].length >= refLimits.value[k]) return
  const sig = asset.id ? `id:${asset.id}` : `url:${asset.url}`
  if (refs.value[k].some((i) => (i.sig || (i.id ? `id:${i.id}` : `url:${i.public_url}`)) === sig)) return
  // 有 asset id 直接引用；极端兜底（无 id）才走 URL 导入。
  const item: UploadItem = asset.id
    ? { id: asset.id, kind: k, filename: asset.filename, public_url: asset.url, sig }
    : { id: '', kind: k, filename: asset.filename, public_url: asset.url, pending: true, sig }
  refs.value = { ...refs.value, [k]: [...refs.value[k], item] }
}


watch(selectedProviderId, () => {
  if (!availableModels.value.find((m) => m.id === selectedModelId.value)) {
    selectedModelId.value = availableModels.value[0]?.id ?? null
  }
})

// Build a JSON-view-friendly representation that mirrors the EXACT shape the
// selected provider will receive when uploads are present. The JSON preview
// should match the eventual request body the adapter sends:
//   - doubao-video: refs are folded into a top-level `content[]` array
//   - xai-image: one ref uses `image`, multiple refs use `images` (JSON objects)
//   - openai (image kind): refs go into a top-level `image` field
// On submit the UI sends `params` + `refs` separately to /api/tasks/run; the
// adapter assembles the final request. This preview is purely cosmetic so the
// user can see what the upstream call will look like.
function buildPreviewParams(pIn: Record<string, unknown>): Record<string, unknown> {
  // use_asset_library 是内部标志（是否走素材库），不会外发上游 → 预览里也不显示。
  const p = { ...pIn }
  delete (p as any).use_asset_library
  const rImg = refs.value.image.map((r) => r.public_url)
  const rVid = refs.value.video.map((r) => r.public_url)
  const rAud = refs.value.audio.map((r) => r.public_url)
  // xAI has its own parameter names and switches to the JSON edit shape when
  // source images are present. With `auto`, omit aspect_ratio for edits so the
  // output follows the first source image, matching the upstream default.
  if (apiFormat.value === 'xai-image' && kind.value === 'image') {
    const base = { ...p }
    const aspectRatio = String(base.aspect_ratio ?? base.ratio ?? 'auto')
    const rawResolution = String(base.resolution ?? base.image_resolution ?? '1k').toLowerCase()
    const resolution = rawResolution === '2k' ? '2k' : '1k'
    for (const key of ['aspect_ratio', 'ratio', 'resolution', 'image_resolution', 'size', 'image', 'images']) {
      delete (base as any)[key]
    }
    const normalized = {
      ...base,
      ...(rImg.length && aspectRatio === 'auto' ? {} : { aspect_ratio: aspectRatio }),
      resolution,
    }
    if (rImg.length === 1) return { ...normalized, image: { url: rImg[0], type: 'image_url' } }
    if (rImg.length > 1) return { ...normalized, images: rImg.slice(0, 3).map((url) => ({ url, type: 'image_url' })) }
    return normalized
  }

  const hasRefs = rImg.length || rVid.length || rAud.length
  if (!hasRefs) return p

  // Strip UI-only mirror keys
  const base = { ...p }
  delete (base as any).ratio
  delete (base as any).image_resolution

  if (apiFormat.value === 'doubao-video') {
    const content: Record<string, unknown>[] = []
    if (prompt.value.trim()) content.push({ type: 'text', text: prompt.value.trim() })
    for (const url of rImg) content.push({ type: 'image_url', role: 'reference_image', image_url: { url } })
    for (const url of rVid) content.push({ type: 'video_url', role: 'reference_video', video_url: { url } })
    for (const url of rAud) content.push({ type: 'audio_url', role: 'reference_audio', audio_url: { url } })
    return { ...p, content }
  }
  if ((apiFormat.value === 'openai-sync' || apiFormat.value === 'openai-async' || apiFormat.value === 'full-url') && kind.value === 'image' && rImg.length) {
    return { ...base, image: rImg.length === 1 ? rImg[0] : rImg }
  }
  return p
}

// ---------- Param + ref persistence ----------
// We persist the last params and refs per `kind` (image / video). When the user
// switches between platforms in the SAME kind, params/refs stay intact (just
// reusable across providers). When the kind flips (e.g. image → video), we
// load that kind's last-saved state from localStorage, or fall back to the
// model's default_params.
const LS_KEY_PARAMS = 'relay.lastParams.v1'    // { image?: {...}, video?: {...} }
const LS_KEY_REFS = 'relay.lastRefs.v1'        // { image?: refsState, video?: refsState }
// readStore / writeStore 来自 composables/useLocalStorage（Nuxt 自动导入）。

function snapshotParamsToLS(kind: ModelKind | null) {
  if (!kind) return
  const store = readStore<Record<string, unknown>>(LS_KEY_PARAMS)
  store[kind] = formParams.value
  writeStore(LS_KEY_PARAMS, store)
}
function snapshotRefsToLS(kind: ModelKind | null) {
  if (!kind) return
  const store = readStore<typeof refs.value>(LS_KEY_REFS)
  store[kind] = refs.value
  writeStore(LS_KEY_REFS, store)
}

watch(selectedModel, (m, prevModel) => {
  if (!m) return
  const newKind = m.kind
  const prevKind = prevModel?.kind ?? null
  // Same kind → keep current params/refs (cross-provider reuse).
  if (prevModel && prevKind === newKind) return
  // Different kind (or first load): try localStorage for this kind; fall back
  // to the model's default_params; refs are reset on kind change.
  const lsParams = readStore<Record<string, unknown>>(LS_KEY_PARAMS)[newKind]
  const dp = m.default_params || {}
  formParams.value = lsParams && Object.keys(lsParams).length ? { ...lsParams } : { ...dp }
  const lsRefs = readStore<typeof refs.value>(LS_KEY_REFS)[newKind]
  if (lsRefs && lsRefs.image && lsRefs.video && lsRefs.audio) {
    refs.value = { image: [...lsRefs.image], video: [...lsRefs.video], audio: [...lsRefs.audio] }
  } else {
    clearRefs()
  }
  try { jsonParamsText.value = JSON.stringify(buildPreviewParams(formParams.value), null, 2) } catch { jsonParamsText.value = '' }
  jsonParamsError.value = null
}, { immediate: false })

// Snapshot params + refs to localStorage on every change (debounced via watch).
watch(formParams, () => snapshotParamsToLS(kind.value), { deep: true })
watch(refs, () => snapshotRefsToLS(kind.value), { deep: true })

watch([formParams, refs, prompt], () => {
  if (paramMode.value === 'form') {
    try {
      jsonParamsText.value = JSON.stringify(buildPreviewParams(formParams.value), null, 2)
    } catch { /* ignore */ }
  }
}, { deep: true })

// ---------- polling (delegated to tasks store) ----------
const TERMINAL = new Set(['succeeded', 'failed'])
function startPoll(id: number) { tasksStore.startPoll(id) }
function stopPoll(id: number) { tasksStore.stopPoll(id) }

// First-mount load. Pinia caches across route navigations; if the store
// already has data (e.g. user came back from /providers) we skip the
// fetch and just hydrate the local UI state from cache.
async function loadAll() {
  await Promise.all([providersStore.loadAll(), tasksStore.loadAll()])
  const enabled = providers.value.find((p) => p.enabled && p.models.some((m) => m.enabled))
  if (!enabled) return
  if (!selectedProviderId.value) {
    selectedProviderId.value = enabled.id
    const firstModel = enabled.models.find((m) => m.enabled)
    selectedModelId.value = firstModel?.id || null
    // Prefer localStorage params/refs for this kind; fall back to default_params
    const k = firstModel?.kind || null
    const dp = firstModel?.default_params || {}
    const lsParams = k ? readStore<Record<string, unknown>>(LS_KEY_PARAMS)[k] : undefined
    formParams.value = lsParams && Object.keys(lsParams).length ? { ...lsParams } : { ...dp }
    const lsRefs = k ? readStore<typeof refs.value>(LS_KEY_REFS)[k] : undefined
    if (lsRefs && lsRefs.image && lsRefs.video && lsRefs.audio) {
      refs.value = { image: [...lsRefs.image], video: [...lsRefs.video], audio: [...lsRefs.audio] }
    }
    try { jsonParamsText.value = JSON.stringify(buildPreviewParams(formParams.value), null, 2) } catch { jsonParamsText.value = '' }
  }
}

onMounted(async () => {
  window.addEventListener('keyup', onCtrlGesture)
  await loadAll()
})
// Pollers live in the tasks store and survive route navigations; no cleanup needed.

// Manual refresh button → force a re-fetch (bypasses the staleness cache).
function refreshTasks() { void tasksStore.loadAll(true) }

function parseParams(): Record<string, unknown> | null {
  jsonParamsError.value = null
  if (paramMode.value === 'form') return { ...formParams.value }
  const txt = jsonParamsText.value.trim()
  if (!txt) return {}
  try {
    const v = JSON.parse(txt)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // Strip preview-only fields. Actual refs travel via the submit body's
      // dedicated `refs` field; the adapter rebuilds `content` / `image` from
      // resolved upload URLs server-side. We don't want users to forward stale
      // preview values back to providers.
      const out = { ...(v as Record<string, unknown>) }
      delete out._refs
      delete out.content
      delete out.image
      return out
    }
    jsonParamsError.value = 'JSON 必须是对象'
    return null
  } catch (err: any) {
    jsonParamsError.value = `JSON 解析失败: ${err?.message || ''}`
    return null
  }
}

// 参考素材 → asset id：统一走通用方法（composables/useRefUpload.ts），
// 「先传 R2 拿 id 再跑任务」，服务端 sha256 去重、生成素材零重复导入。
const resolveRefKind = (items: UploadItem[]) => uploadRefsToAssetIds(items)

// 润色：调用润色文本模型优化当前提示词。需先在平台页配置润色模型。
async function polishPrompt() {
  if (polishing.value || !prompt.value.trim() || !kind.value) return
  if (!hasPolishModel.value) {
    errorBanner.value = '请先在「平台」页配置一个用于润色的文本模型（模型设置中开启「用于润色」）'
    return
  }
  trackButtonClick('polish', { kind: kind.value })
  polishing.value = true
  errorBanner.value = null
  try {
    const res = await useDataSource().polishPrompt({
      prompt: prompt.value,
      kind: kind.value,
      customCommand: customPolishCommand.value || undefined,
    })
    if (res?.polished) {
      prompt.value = res.polished
      promptEditorRef.value?.restoreContent(res.polished, {
        image: refs.value.image.map((r) => ({ sig: r.sig!, kind: 'image' as const, url: r.public_url })),
        video: refs.value.video.map((r) => ({ sig: r.sig!, kind: 'video' as const, url: r.public_url })),
        audio: refs.value.audio.map((r) => ({ sig: r.sig!, kind: 'audio' as const, url: r.public_url })),
      })
      // 润色成功后清空自定义命令，下次默认回到默认命令
      customPolishCommand.value = ''
    }
  } catch (err: any) {
    errorBanner.value = err?.data?.statusMessage || err?.statusMessage || err?.message || '润色失败'
  } finally {
    polishing.value = false
  }
}

async function submit() {
  errorBanner.value = null
  if (!selectedProviderId.value) { errorBanner.value = '请选择平台'; return }
  if (!selectedModelId.value) { errorBanner.value = '请选择模型'; return }
  if (!prompt.value.trim()) { errorBanner.value = '请填写提示词'; return }
  const params = parseParams()
  if (params === null) { errorBanner.value = jsonParamsError.value; return }

  trackButtonClick('submit', { provider_id: selectedProviderId.value, model_id: selectedModelId.value, kind: kind.value })

  submitting.value = true
  try {
    // Upload pending refs first (deferred upload); server dedups by sha256.
    const [imageIds, videoIds, audioIds] = await Promise.all([
      resolveRefKind(refs.value.image),
      resolveRefKind(refs.value.video),
      resolveRefKind(refs.value.audio),
    ])
    const resolvedBySig = new Map<string, string>()
    const registerResolved = (items: UploadItem[], ids: string[]) => {
      if (items.length !== ids.length) throw new Error('参考素材上传结果不完整，请重试')
      items.forEach((item, index) => {
        const id = ids[index]
        if (!id) throw new Error('参考素材上传结果无效，请重试')
        const sig = item.sig || (item.id ? `id:${item.id}` : `url:${item.public_url}`)
        resolvedBySig.set(sig, id)
        if (item.id) resolvedBySig.set(`id:${item.id}`, id)
        if (item.public_url) resolvedBySig.set(`url:${item.public_url}`, id)
      })
    }
    registerResolved(refs.value.image, imageIds)
    registerResolved(refs.value.video, videoIds)
    registerResolved(refs.value.audio, audioIds)
    const segments = promptSegments.value.map((segment) => {
      if (segment.type === 'text') return segment
      const uploadId = resolvedBySig.get(segment.sig)
      if (!uploadId) throw new Error('提示词中的引用素材无法解析，请重新选择素材')
      return { type: 'ref' as const, upload_id: uploadId, kind: segment.kind }
    })

    // Truncate the readable prompt to the same limit enforced by the editor.
    const MAX_PROMPT = 2000
    const modelPrompt = prompt.value.slice(0, MAX_PROMPT)
    const res = await useDataSource().runTask({
      provider_id: selectedProviderId.value,
      model_id: selectedModelId.value,
      prompt: modelPrompt,
      params,
      refs: {
        image: Array.from(new Set(imageIds)),
        video: Array.from(new Set(videoIds)),
        audio: Array.from(new Set(audioIds)),
      },
      segments: segments.length ? segments : undefined,
    })
    tasksStore.upsert(res)
    activeId.value = res.id
    detailTab.value = 'preview'
    if (!TERMINAL.has(res.status)) startPoll(res.id)
  } catch (err: any) {
    errorBanner.value
      = err?.data?.statusMessage
      || err?.statusMessage
      || err?.message
      || '请求失败'
  } finally {
    submitting.value = false
  }
}

async function deleteTask(id: number) {
  if (!(await confirm({ title: '删除这条测试记录？', danger: true }))) return
  // 乐观删除：确认后立刻从列表移除并提示成功，不等网络——服务端删除失败也只在
  // 下次 loadAll 时（软删过滤）自然恢复，绝不因慢网络卡住交互。
  tasksStore.remove(id)
  if (activeId.value === id) activeId.value = null
  notify.success('已删除记录')
  useDataSource().deleteTask(id).catch(() => { /* 后台软删，失败留待下次刷新 */ })
}

// Toggle a task's favorite flag (optimistic; persisted via API).
async function toggleTaskFavorite(t: TaskRow, e?: Event) {
  e?.stopPropagation()
  const next = !t.favorite
  tasksStore.upsert({ ...t, favorite: next })
  try {
    await useDataSource().setFavorite(t.id, next)
  } catch {
    tasksStore.upsert({ ...t, favorite: !next }) // rollback
  }
}

// statusLabel 来自 composables/useTaskLabels（Nuxt 自动导入）。

// 分析(结构化/敏感词)是异步后台任务：TaskDetail 轮询到新结果时回传，
// 这里写回 store，让任务列表的「已分析」标记即时刷新。
function onAnalysisUpdate(analysis: unknown) {
  const t = activeTask.value
  if (!t) return
  tasksStore.upsert({ ...t, analysis: analysis as TaskRow['analysis'] })
}

// 实时时钟：仅在有进行中(pending/running)任务时每秒走一次，用于显示已消耗时长。
const nowTick = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
const hasRunningTask = computed(() => tasks.value.some((t) => t.status === 'pending' || t.status === 'running'))
watch(hasRunningTask, (running) => {
  if (running && !tickTimer) {
    tickTimer = setInterval(() => { nowTick.value = Date.now() }, 1000)
  } else if (!running && tickTimer) {
    clearInterval(tickTimer); tickTimer = null
  }
}, { immediate: true })
onBeforeUnmount(() => {
  if (tickTimer) clearInterval(tickTimer)
  if (hoverTimer) clearTimeout(hoverTimer)
  if (hoverCloseTimer) clearTimeout(hoverCloseTimer)
  if (ctrlTapTimer) clearTimeout(ctrlTapTimer)
  window.removeEventListener('keyup', onCtrlGesture)
})
// 任务已消耗时长：进行中按 now - created 实时计算，终态用 latency_ms。
function elapsedLabel(t: TaskRow): string {
  if (t.status === 'pending' || t.status === 'running') {
    return formatDuration(Math.max(0, nowTick.value - t.created_at))
  }
  return formatDuration(t.latency_ms)
}

// statusPillClass / statusDotClass 来自 composables/useTaskLabels（Nuxt 自动导入）。

// Active task's first result asset — real dimensions + byte size for the header.
// Measured lazily off the DOM/HEAD and cached per URL.
const assetMetaCache = reactive<Record<string, { dims?: string; size?: string }>>({})
const activeAsset = computed(() => {
  const t = activeTask.value
  const url = t ? taskResultUrls(t)[0] : null
  if (!url) return null
  return assetMetaCache[url] || null
})
function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(2)} MB`
}
async function measureAsset(url: string, kind: 'image' | 'video') {
  if (assetMetaCache[url]) return
  assetMetaCache[url] = {}
  // ── real byte size (computed ourselves, not from the gen API) ──
  if (url.startsWith('data:')) {
    // base64 data URL → decode length precisely
    const b64 = url.slice(url.indexOf(',') + 1)
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
    const bytes = Math.floor(b64.length * 3 / 4) - pad
    assetMetaCache[url] = { ...assetMetaCache[url], size: fmtBytes(bytes) }
  } else {
    // remote: try HEAD, fall back to fetching the blob and measuring its size
    fetch(url, { method: 'HEAD' }).then((r) => {
      const cl = r.headers.get('content-length')
      if (cl) { assetMetaCache[url] = { ...assetMetaCache[url], size: fmtBytes(Number(cl)) }; return Promise.reject('done') }
      return fetch(url)
    }).then((r) => r && r.blob()).then((blob) => {
      if (blob) assetMetaCache[url] = { ...assetMetaCache[url], size: fmtBytes(blob.size) }
    }).catch(() => { /* HEAD gave size, or failed */ })
  }
  // ── dimensions via the decoded element (always client-computed) ──
  if (kind === 'image') {
    const img = new Image()
    img.onload = () => { assetMetaCache[url] = { ...assetMetaCache[url], dims: `${img.naturalWidth}×${img.naturalHeight}` } }
    img.src = url
  } else {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = () => { assetMetaCache[url] = { ...assetMetaCache[url], dims: `${v.videoWidth}×${v.videoHeight}` } }
    v.src = url
  }
}
watch(activeTask, (t) => {
  const url = t ? taskResultUrls(t)[0] : null
  if (url && t && t.kind !== 'text') measureAsset(url, t.kind)
}, { immediate: true })

// Task-list thumbnail (resilient — same fallback as the preview area).
function thumbUrl(t: TaskRow): string | null {
  const url = taskResultUrls(t)[0] || null
  // Don't request expired Seedance video URLs — fall back to the icon.
  if (url && isVideoExpired(t, url)) return null
  return url
}

// Drag a task's result asset into the creation area's reference uploader.
// Payload is read by UnifiedReferenceUpload's drop handler.
function onTaskDragStart(ev: DragEvent, t: TaskRow) {
  const url = thumbUrl(t)
  if (!url || !ev.dataTransfer) return
  ev.dataTransfer.effectAllowed = 'copy'
  ev.dataTransfer.setData('application/x-relay-asset', JSON.stringify({
    source: 'generated',
    id: `task:${t.id}:0`,
    kind: t.kind,
    url,
    filename: null,
  }))
}

// ── Task prompt hover-card ────────────────────────────────────
// Renders the task 概览 (reused TaskDetail in preview mode) in a floating card
// beside the hovered row, teleported + fixed so it's immune to the rail's
// overflow clipping. The card stays open while the mouse is over it (so its
// scrollable content is usable), closing only when the pointer leaves both the
// row and the card.
const hoverCard = ref<{ task: TaskRow; rect: DOMRect } | null>(null)
let hoverTimer: ReturnType<typeof setTimeout> | null = null
let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null
function onTaskHover(ev: MouseEvent, t: TaskRow) {
  if (!(t.prompt || '').trim()) return
  const el = ev.currentTarget as HTMLElement
  if (hoverCloseTimer) { clearTimeout(hoverCloseTimer); hoverCloseTimer = null }
  if (hoverTimer) clearTimeout(hoverTimer)
  hoverTimer = setTimeout(() => {
    hoverCard.value = { task: t, rect: el.getBoundingClientRect() }
  }, 120)
}
function onTaskHoverLeave() {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null }
  // Defer the close so moving the pointer onto the card cancels it.
  if (hoverCloseTimer) clearTimeout(hoverCloseTimer)
  hoverCloseTimer = setTimeout(() => { hoverCard.value = null }, 160)
}
// Pointer entered the card → keep it open.
function onHoverCardEnter() {
  if (hoverCloseTimer) { clearTimeout(hoverCloseTimer); hoverCloseTimer = null }
}
function onHoverCardLeave() {
  if (hoverCloseTimer) clearTimeout(hoverCloseTimer)
  hoverCloseTimer = setTimeout(() => { hoverCard.value = null }, 160)
}
const hoverCardStyle = computed<Record<string, string>>(() => {
  const c = hoverCard.value
  if (!c || typeof window === 'undefined') return {}
  const margin = 8
  const cardW = 360
  const cardH = 420
  const vw = window.innerWidth
  const vh = window.innerHeight
  const r = c.rect
  const actualH = Math.min(cardH, Math.max(200, vh - margin * 2))
  const s: Record<string, string> = { width: `${cardW}px`, height: `${actualH}px` }
  // Horizontal: prefer to the left of the row (rail sits on the right edge);
  // fall back to the right if there isn't room.
  let left = r.left - margin - cardW >= margin ? r.left - margin - cardW : r.right + margin
  left = Math.max(margin, Math.min(left, vw - cardW - margin))
  s.left = `${left}px`
  const top = Math.max(margin, Math.min(r.top, vh - actualH - margin))
  s.top = `${top}px`
  return s
})
// hh:mm for a task row (date is shown by the group header).
function hhmm(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}
// Human date-group label: 今天 / 昨天 / MM-DD.
function dayLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000)
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ── Task-list filter (by platform / model) ───────────────────
const filterOpen = ref(false)
const filterProvider = ref<string | null>(null)  // provider_name
const filterModel = ref<string | null>(null)      // model_name
const filterFavorite = ref(false)                  // only show favorited
const filterStructured = ref(false)                // only show structured-analyzed
const filterSensitive = ref(false)                 // only show sensitive-analyzed
// 任务是否做过结构化 / 敏感词分析（analysis 在顶层为结构化，sensitive 键为敏感词）。
function hasStructured(t: TaskRow): boolean {
  const a = t.analysis as any
  return !!(a && typeof a === 'object' && (a.structured || a.segments?.length))
}
function hasSensitive(t: TaskRow): boolean {
  const a = t.analysis as any
  return !!(a && typeof a === 'object' && a.sensitive)
}
// 隐藏收藏（#4）：连按 3 次 Ctrl（mac/win 都是 Ctrl）切换「隐藏被收藏的任务」。
// 用 keyup 计数，两次按键间隔 > 600ms 则重置，达到 3 次即翻转开关并轻提示。
// 开关状态存 localStorage，刷新后保持不变。
const LS_KEY_HIDE_FAV = 'relay:tasks:hideFavorited'
const hideFavorited = ref(false)
onMounted(() => { if (localStorage.getItem(LS_KEY_HIDE_FAV) === '1') hideFavorited.value = true })
watch(hideFavorited, (v) => { localStorage.setItem(LS_KEY_HIDE_FAV, v ? '1' : '0') })
let ctrlTaps = 0
let ctrlTapTimer: ReturnType<typeof setTimeout> | null = null
function onCtrlGesture(e: KeyboardEvent) {
  if (e.key !== 'Control') return
  ctrlTaps++
  if (ctrlTapTimer) clearTimeout(ctrlTapTimer)
  ctrlTapTimer = setTimeout(() => { ctrlTaps = 0 }, 600)
  if (ctrlTaps >= 3) {
    ctrlTaps = 0
    if (ctrlTapTimer) { clearTimeout(ctrlTapTimer); ctrlTapTimer = null }
    hideFavorited.value = !hideFavorited.value
  }
}

const filterProviderOptions = computed(() => Array.from(new Set(tasksStore.tasks.map((t) => t.provider_name))).filter(Boolean))
const filterModelOptions = computed(() => Array.from(new Set(
  tasksStore.tasks.filter((t) => !filterProvider.value || t.provider_name === filterProvider.value).map((t) => t.model_name),
)).filter(Boolean))
const filterActive = computed(() => !!filterProvider.value || !!filterModel.value || filterFavorite.value || filterStructured.value || filterSensitive.value)
const filteredTasks = computed(() => tasksStore.tasks.filter((t) =>
  (!filterProvider.value || t.provider_name === filterProvider.value)
  && (!filterModel.value || t.model_name === filterModel.value)
  && (!filterFavorite.value || t.favorite)
  && (!filterStructured.value || hasStructured(t))
  && (!filterSensitive.value || hasSensitive(t))
  && (!hideFavorited.value || !t.favorite),  // 连按 3 次 Ctrl 隐藏收藏任务（#4）
))
function clearFilter() { filterProvider.value = null; filterModel.value = null; filterFavorite.value = false; filterStructured.value = false; filterSensitive.value = false }

// Group filtered tasks by day (今天/昨天/MM-DD) for the rail, newest first.
const groupedTasks = computed(() => {
  const groups: { label: string; items: TaskRow[] }[] = []
  let cur: { label: string; items: TaskRow[] } | null = null
  for (const t of filteredTasks.value) {
    const label = dayLabel(t.created_at)
    if (!cur || cur.label !== label) { cur = { label, items: [] }; groups.push(cur) }
    cur.items.push(t)
  }
  return groups
})

// ── Task-list multi-select (batch delete / download) ──────────
const selectMode = ref(false)
const selectedIds = ref<Set<number>>(new Set())
function toggleSelectMode() {
  selectMode.value = !selectMode.value
  if (!selectMode.value) selectedIds.value = new Set()
}
function toggleSelect(id: number) {
  const next = new Set(selectedIds.value)
  next.has(id) ? next.delete(id) : next.add(id)
  selectedIds.value = next
}
const allSelected = computed(() => filteredTasks.value.length > 0
  && filteredTasks.value.every((task) => selectedIds.value.has(task.id)))
function toggleSelectAll() {
  selectedIds.value = allSelected.value ? new Set() : new Set(filteredTasks.value.map((task) => task.id))
}
async function batchDelete() {
  const ids = [...selectedIds.value]
  if (!ids.length) return
  if (!(await confirm({ title: `删除选中的 ${ids.length} 条任务？`, danger: true }))) return
  for (const id of ids) {
    try { await useDataSource().deleteTask(id); tasksStore.remove(id) } catch { /* skip */ }
    if (activeId.value === id) activeId.value = null
  }
  selectedIds.value = new Set()
  selectMode.value = false
  notify.success(`已删除 ${ids.length} 条任务`)
}
async function batchDownload() {
  const ids = [...selectedIds.value]
  const picked = ids.map((id) => tasks.value.find((x) => x.id === id)).filter(Boolean) as TaskRow[]
  if (!picked.length) return
  try {
    // Export includes refs plus request/response snapshots, which list summaries
    // deliberately omit. Hydrate in small parallel batches so a large selection
    // neither serializes dozens of mainland RTTs nor bursts every detail at once.
    const hydrated: TaskRow[] = []
    const concurrency = 4
    for (let i = 0; i < picked.length; i += concurrency) {
      const chunk = await Promise.all(picked.slice(i, i + concurrency).map((t) => (
        t.refs === undefined ? tasksStore.loadDetail(t.id) : Promise.resolve(t)
      )))
      hydrated.push(...chunk)
    }
    await downloadTasksZip(hydrated, resolveTaskModel)
  } catch (err: any) {
    notify.error(err?.data?.statusMessage || err?.statusMessage || err?.message || '任务详情加载失败，无法打包')
  }
}

// 解析任务关联的 live 模型（用于 readme 成本计算）。
function resolveTaskModel(t: TaskRow) {
  return providers.value.flatMap((p) => p.models).find((m) => m.id === t.model_id) || null
}

// 重试 — refill all params/prompt/refs back into the 创作区 for re-running.
async function retryTask(t: TaskRow) {
  // List rows omit refs and provider payload snapshots. Fetch the full record
  // only when the user explicitly asks to reproduce a task.
  if (t.refs === undefined) {
    try {
      t = await tasksStore.loadDetail(t.id)
    } catch (err: any) {
      // Re-running a summary without its reference assets would silently change
      // the request. Fail closed instead of clearing refs and submitting a
      // semantically different task.
      notify.error(err?.data?.statusMessage || err?.statusMessage || err?.message || '任务详情加载失败，请稍后重试')
      return
    }
  }
  if (t.provider_id) selectedProviderId.value = t.provider_id
  nextTick(() => {
    if (t.model_id) selectedModelId.value = t.model_id
    nextTick(() => {
      prompt.value = t.prompt || ''
      if (t.params && typeof t.params === 'object') {
        formParams.value = { ...t.params }
        try { jsonParamsText.value = JSON.stringify(buildPreviewParams(formParams.value), null, 2) } catch { /* ignore */ }
      }
      // Restore reference assets (already-uploaded ids) from the task record.
      if (t.refs) {
        const mk = (r: { asset_id: string; filename: string | null; public_url: string }, kind: 'image' | 'video' | 'audio') =>
          ({ id: r.asset_id, kind, filename: r.filename, public_url: r.public_url, sig: `id:${r.asset_id}` })
        refs.value = {
          image: (t.refs.image || []).map((r) => mk(r, 'image')),
          video: (t.refs.video || []).map((r) => mk(r, 'video')),
          audio: (t.refs.audio || []).map((r) => mk(r, 'audio')),
        }
        // Rebuild the editor with inline chips so 「图片N」 tokens render as @-chips.
        nextTick(() => {
          promptEditorRef.value?.restoreContent(t.prompt || '', {
            image: refs.value.image.map((r) => ({ sig: r.sig!, kind: 'image' as const, url: r.public_url })),
            video: refs.value.video.map((r) => ({ sig: r.sig!, kind: 'video' as const, url: r.public_url })),
            audio: refs.value.audio.map((r) => ({ sig: r.sig!, kind: 'audio' as const, url: r.public_url })),
          })
        })
      } else {
        clearRefs()
      }
    })
  })
}

// First displayable result URL of the active task (resilient fallback).
const firstResultUrl = computed(() => activeTask.value ? taskResultUrls(activeTask.value)[0] || null : null)
// 任务成本：seedance 用内置费率，其他模型用其定价（按次/按量拆分）
const activeCost = computed(() => {
  const t = activeTask.value
  if (!t) return null
  const m = providers.value.flatMap((p) => p.models).find((mm) => mm.id === t.model_id) || null
  return computeTaskCost(t, m)
})

async function downloadActive(t: TaskRow) {
  // 单个下载（#7）：只下载生成结果本身（图片/视频）。批量下载才打包全部信息。
  await downloadTaskZip(t, resolveTaskModel(t))
}

// Unified duration formatter (shared composable) — keeps "Xm XXs" everywhere.
const formatLatency = formatDuration

function applyDefault() {
  const dp = selectedModel.value?.default_params || {}
  formParams.value = { ...dp }
  try { jsonParamsText.value = JSON.stringify(buildPreviewParams(dp), null, 2) } catch { jsonParamsText.value = '' }
  jsonParamsError.value = null
  // 重置默认时一并清空参考素材和提示词
  clearRefs()
  prompt.value = ''
  promptSegments.value = []
}

function switchMode(m: ParamMode) {
  if (m === paramMode.value) return
  if (m === 'json') {
    try {
      jsonParamsText.value = JSON.stringify(buildPreviewParams(formParams.value), null, 2)
    } catch { jsonParamsText.value = '' }
  } else {
    const txt = jsonParamsText.value.trim()
    if (txt) {
      try {
        const v = JSON.parse(txt)
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const obj = { ...(v as Record<string, unknown>) }
          // Strip preview-only fields — refs are tracked in refs.value, not in formParams
          delete obj._refs
          delete obj.content
          delete obj.image
          formParams.value = obj
        }
      } catch { /* keep */ }
    }
  }
  paramMode.value = m
}

// Cookie persists across reloads. Stored as the literal '1' (collapsed) or '0'
// (expanded). Default = collapsed.
const railCollapsedCookie = useCookie<string>('console_rail_collapsed', {
  default: () => '1',
  maxAge: 60 * 60 * 24 * 365,
  sameSite: 'lax',
})
const railCollapsed = ref(railCollapsedCookie.value !== '0')
watch(railCollapsed, (v) => {
  railCollapsedCookie.value = v ? '1' : '0'
})
function toggleRail() {
  railCollapsed.value = !railCollapsed.value
}
</script>

<template>
  <!-- < lg: stacked + page scrolls (auto-rows so each column gets its content
       height). ≥ lg: fixed 3-column, each column scrolls internally. -->
  <div class="grid h-full min-h-0 grid-cols-1 gap-4 max-lg:auto-rows-min max-lg:overflow-y-auto transition-[grid-template-columns] duration-200 lg:h-full" :class="railCollapsed
    ? 'lg:grid-cols-[380px_minmax(0,1fr)_56px] xl:grid-cols-[420px_minmax(0,1fr)_60px] 2xl:grid-cols-[460px_minmax(0,1fr)_60px]'
    : 'lg:grid-cols-[380px_minmax(0,1fr)_260px] xl:grid-cols-[420px_minmax(0,1fr)_280px] 2xl:grid-cols-[460px_minmax(0,1fr)_280px]'">
    <!-- 第 1 列 · 创作区：选择平台 + 模型、配置参数、上传参考素材、输入提示词、点击运行 -->
    <!-- 左：平台 + 参数 + 提示词 -->
    <section class="surface flex h-full min-h-0 flex-col max-lg:h-auto max-lg:max-h-[80vh]">
      <div class="scroll-area flex-1 overflow-y-auto p-3">
        <!-- flex column so the params panel can grab remaining height for the JSON editor -->
        <div class="flex min-h-full flex-col gap-4">
          <div>
            <div class="field-label">平台</div>
            <div v-if="!visibleProviders.length" class="text-[12px] text-[var(--c-fg-4)]">暂无平台</div>
            <div v-else class="flex flex-wrap gap-1.5">
              <button v-for="p in visibleProviders" :key="p.id" type="button"
                class="rounded-[4px] border px-2.5 py-1 text-[12px] transition"
                :class="selectedProviderId === p.id
                  ? 'border-primary-500 bg-primary-50 text-primary-700'
                  : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
                @click="selectedProviderId = p.id">{{ p.name }}</button>
            </div>
          </div>
          <div>
            <div class="field-label">模型</div>
            <div v-if="!availableModels.length" class="text-[12px] text-[var(--c-fg-4)]">无可用模型</div>
            <div v-else class="flex flex-wrap gap-1.5">
              <button v-for="m in availableModels" :key="m.id" type="button"
                class="inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-1 text-[12px] transition" :class="selectedModelId === m.id
                  ? 'border-primary-500 bg-primary-50 text-primary-700'
                  : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
                @click="selectedModelId = m.id">
                <ModelIcon :model-id="m.model_id" :kind="m.kind" :size="16" />
                <span>{{ m.display_name || m.model_id }}</span>
              </button>
            </div>
          </div>

          <!-- 参数：表单 / JSON。flex-1 lets the panel stretch to fill the scrollable column. -->
          <div class="flex min-h-[260px] flex-1 flex-col rounded-[6px] border border-[var(--c-border)]">
            <div class="flex flex-shrink-0 items-center justify-between border-b border-[var(--c-border)] px-3 py-2">
              <div class="seg-toggle">
                <button type="button" class="seg-btn" :class="paramMode === 'form' ? 'seg-btn-active' : ''"
                  @click="switchMode('form')">表单</button>
                <button type="button" class="seg-btn" :class="paramMode === 'json' ? 'seg-btn-active' : ''"
                  @click="switchMode('json')">JSON</button>
              </div>
              <UButton v-if="selectedModel" size="xs" variant="outline" color="neutral"
                @click="applyDefault">重置默认</UButton>
            </div>
            <div class="flex min-h-0 flex-1 flex-col p-3">
              <ParamsForm v-if="paramMode === 'form'" v-model="formParams" v-model:refs="refs" :api-format="apiFormat"
                :kind="kind" />
              <div v-else class="flex min-h-0 flex-1 flex-col">
                <!-- JSON editor — fills the remaining parent height. -->
                <textarea v-model="jsonParamsText"
                  class="block w-full flex-1 resize-none rounded-[4px] border border-[var(--c-border)] bg-[var(--c-surface)] px-3 py-2 font-mono text-[12px] leading-relaxed text-[var(--c-fg)] outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20"
                  placeholder='{ "size": "1024x1024", "n": 1 }' />
                <p v-if="jsonParamsError" class="mt-1.5 text-[12px] text-red-600">{{ jsonParamsError }}</p>
              </div>
            </div>
          </div>

          <UAlert v-if="errorBanner" :title="errorBanner" color="error" variant="soft"
            />
        </div>
      </div>

      <!-- 提示词 + 运行（始终贴底） -->
      <div class="flex-shrink-0 border-t border-[var(--c-border)] bg-[var(--c-surface)] p-3">
        <div class="overflow-visible rounded-[6px] border bg-[var(--c-surface)] transition-colors"
          :class="promptFocused ? 'border-primary-500 ring-2 ring-primary-500/20' : 'border-[var(--c-border)]'">
          <PromptEditor ref="promptEditorRef" v-model="prompt" v-model:segments="promptSegments" :allow-kinds="allowKinds"
            :mentioned-refs="allRefItems" @submit="submit" @pick-asset="addMentionedAsset"
            @focusin="promptFocused = true" @focusout="promptFocused = false">
            <template #toolbar>
              <div class="group/polish relative flex items-center">
                <!-- hover 按钮时，自定义润色命令输入框浮现在按钮上方。
                     用 pb-1.5 而非 mb-1.5：把 6px 间隙做进浮层的可 hover 区域，
                     鼠标从按钮移到输入框时不会经过「既非按钮也非浮层」的死区而消失。 -->
                <div
                  class="pointer-events-none absolute bottom-full right-0 w-64 pb-1.5 opacity-0 transition-opacity duration-150 group-hover/polish:pointer-events-auto group-hover/polish:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
                  <div class="rounded-[6px] border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5 shadow-wf">
                    <input
                      v-model="customPolishCommand"
                      type="text"
                      placeholder="自定义润色命令（留空用默认）"
                      class="h-7 w-full rounded-[4px] border border-[var(--c-border)] bg-[var(--c-surface)] px-2 text-[12px] text-[var(--c-fg-3)] outline-none focus:border-primary-400 placeholder:text-[var(--c-fg-7)]"
                      @click.stop
                      @keydown.enter.prevent="polishPrompt"
                    />
                  </div>
                </div>
                <button type="button" class="pill-btn !h-6 !px-2 !text-[12px]"
                  :disabled="polishing || !prompt.trim() || !kind"
                  :title="hasPolishModel
                    ? (customPolishCommand.trim() ? '用自定义命令润色' : '用润色模型针对当前创作类型优化提示词')
                    : '请先在平台页配置一个用于润色的文本模型'"
                  @click="polishPrompt">
                  <UIcon
                    :name="polishing
                      ? 'i-carbon-circle-dash'
                      : (customPolishCommand.trim() ? 'i-carbon-pen-fountain' : 'i-carbon-magic-wand')"
                    class="h-3.5 w-3.5" :class="polishing ? 'animate-spin' : ''" />
                  {{ polishing ? '润色中' : '润色' }}
                </button>
              </div>
            </template>
          </PromptEditor>
          <div
            class="flex items-center justify-between gap-3 rounded-b-[6px] border-t border-[var(--c-border-2)] bg-[var(--c-surface-2)] px-3 py-2">
            <div class="flex items-center gap-2 text-[12px] text-[var(--c-fg-4)]">
              <kbd
                class="rounded-[3px] border border-[var(--c-border)] bg-[var(--c-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--c-fg-3)]">⌘
                / Ctrl</kbd>
              <span>+</span>
              <kbd
                class="rounded-[3px] border border-[var(--c-border)] bg-[var(--c-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--c-fg-3)]">Enter</kbd>
              <span>提交</span>
            </div>
            <button type="button"
              class="inline-flex h-9 items-center gap-1.5 rounded-[6px] bg-primary-500 px-5 text-[14px] font-medium text-white transition hover:bg-primary-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="submitting" @click="submit">
              {{ submitting ? '请求中' : '搓碟' }}
              <UIcon v-if="!submitting" name="i-carbon-arrow-up" class="h-4 w-4" />
              <UIcon v-else name="i-carbon-circle-dash" class="h-4 w-4 animate-spin" />
            </button>
          </div>
        </div>
        <p v-if="!visibleProviders.length" class="mt-2 text-[12px] text-[var(--c-fg-4)]">
          暂无可用平台。前往 <NuxtLink to="/providers" class="text-primary-500 hover:underline">平台管理</NuxtLink> 添加或启用。
        </p>
      </div>
    </section>

    <!-- 第 2 列 · 结果区：预览生成结果、查看任务概览、检查发往平台的请求、读取平台返回的响应 -->
    <!-- 中：预览 / 概览 / 网络 -->
    <section class="surface flex min-h-0 flex-col max-lg:h-[70vh]">
      <div v-if="activeTask"
        class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--c-border)] px-4 py-2.5">
        <!-- Unified meta row: one consistent pill style for every field. -->
        <div class="flex flex-wrap items-center gap-1.5 text-[12px]">
          <span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium"
            :class="taskStatusPillClass(activeTask)">
            <span class="h-1.5 w-1.5 rounded-full" :class="taskStatusDotClass(activeTask)" />
            {{ taskStatusLabel(activeTask) }}
          </span>
          <KindBadge :kind="activeTask.kind" />
          <span
            class="rounded-full border border-[var(--c-border-2)] bg-[var(--c-surface-2)] px-2 py-0.5 text-[var(--c-fg-3)]">{{
              activeTask.provider_name }}</span>
          <span
            class="rounded-full border border-[var(--c-border-2)] bg-[var(--c-surface-2)] px-2 py-0.5 font-mono text-[11px] text-[var(--c-fg-4)]">{{
              activeTask.model_name }}</span>
          <span
            class="rounded-full border border-[var(--c-border-2)] bg-[var(--c-surface-2)] px-2 py-0.5 font-mono text-[11px] tabular-nums text-[var(--c-fg-4)]">{{
              formatLatency(activeTask.latency_ms) }}</span>
          <span v-if="activeAsset?.dims"
            class="rounded-full border border-[var(--c-border-2)] bg-[var(--c-surface-2)] px-2 py-0.5 font-mono text-[11px] tabular-nums text-[var(--c-fg-4)]">{{
              activeAsset.dims }}</span>
          <span v-if="activeAsset?.size"
            class="rounded-full border border-[var(--c-border-2)] bg-[var(--c-surface-2)] px-2 py-0.5 font-mono text-[11px] tabular-nums text-[var(--c-fg-4)]">{{
              activeAsset.size }}</span>
          <!-- Seedance 成本 -->
          <span v-if="activeCost"
            class="group/cost relative inline-flex items-center gap-1 rounded-full border border-amber-300/60 bg-amber-50 px-2 py-0.5 font-mono text-[11px] tabular-nums text-amber-700">
            {{ formatCost(activeCost.cny) }}
            <UIcon name="i-carbon-help" class="h-3 w-3 cursor-help opacity-70" />
            <span class="pointer-events-none absolute left-0 top-full z-30 mt-1 hidden w-max max-w-[280px] whitespace-normal rounded-[6px] border border-[var(--c-border)] bg-[var(--c-surface)] px-2.5 py-1.5 text-[11px] font-normal leading-relaxed text-[var(--c-fg-3)] shadow-wf group-hover/cost:block">
              {{ activeCost.formula }}
            </span>
          </span>
        </div>
        <!-- 结果操作区: 复刻参数 → 下载 → 删除 (全屏在预览区，不重复) -->
        <div class="flex items-center gap-1.5">
          <button type="button" class="pill-btn" title="把本次任务的平台/模型/参数/提示词/参考素材回填到创作区，便于改一改重跑"
            @click="retryTask(activeTask)">
            <UIcon name="i-carbon-copy" class="h-3.5 w-3.5" /> 复刻参数
          </button>
          <button type="button" class="pill-btn-icon" title="下载结果" :disabled="!firstResultUrl"
            @click="downloadActive(activeTask)">
            <UIcon name="i-carbon-download" class="h-4 w-4" />
          </button>
          <button type="button" class="pill-btn-icon pill-btn-danger text-red-500" title="删除任务"
            @click="deleteTask(activeTask.id)">
            <UIcon name="i-carbon-trash-can" class="h-4 w-4" />
          </button>
        </div>
      </div>

      <div v-if="activeTask" class="flex border-b border-[var(--c-border)] bg-[var(--c-surface)]">
        <button v-for="t in detailTabItems" :key="t.slot" type="button"
          class="px-5 py-2.5 text-[13px] font-medium transition border-b-2 -mb-px" :class="detailTab === t.slot
            ? 'text-primary-500 border-primary-500'
            : 'text-[var(--c-fg-4)] border-transparent hover:text-[var(--c-fg)]'"
          @click="detailTab = t.slot as DetailTab">{{
            t.label }}</button>
      </div>

      <div class="flex min-h-0 flex-1 flex-col">
        <template v-if="activeTask">
          <ResultViewer v-if="detailTab === 'preview'" :task="activeTask" />
          <div v-else-if="activeTask.refs === undefined"
            class="flex min-h-0 flex-1 items-center justify-center gap-2 text-[13px] text-[var(--c-fg-4)]">
            <UIcon name="i-carbon-circle-dash" class="h-4 w-4 animate-spin" />
            正在加载任务详情…
          </div>
          <TaskDetail v-else :task="activeTask" :mode="detailTab" :key="`${activeTask.id}-${detailTab}`"
            @update:analysis="onAnalysisUpdate" />
        </template>
        <ResultViewer v-else :task="null" />
      </div>
    </section>

    <!-- 第 3 列 · 任务列表：默认折叠的最近任务边栏，点击切换当前查看的任务，可手动展开浏览历史 -->
    <!-- 右：最近测试 -->
    <aside class="surface flex h-full min-h-0 flex-col max-lg:h-auto max-lg:max-h-[60vh]">
      <div class="flex items-center gap-2 border-b border-[var(--c-border)] px-3 py-3"
        :class="railCollapsed ? 'justify-center' : 'justify-between'">
        <div v-if="!railCollapsed" class="flex min-w-0 items-center gap-2">
          <h3 class="text-[14px] font-semibold text-[var(--c-fg)]">最近任务</h3>
          <span class="text-[12px] text-[var(--c-fg-4)]">{{ tasks.length }}</span>
        </div>
        <div class="flex items-center gap-1">
          <button v-if="!railCollapsed && tasks.length" type="button" class="icon-btn-ghost relative"
            :class="{ 'icon-btn-ghost-active': filterActive || filterOpen }" title="筛选（平台 / 模型）"
            @click="filterOpen = !filterOpen">
            <UIcon name="i-carbon-filter" class="h-4 w-4" />
            <span v-if="filterActive" class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary-500" />
          </button>
          <button v-if="!railCollapsed && tasks.length" type="button" class="icon-btn-ghost"
            :class="{ 'icon-btn-ghost-active': selectMode }" :title="selectMode ? '退出多选' : '多选'"
            @click="toggleSelectMode">
            <UIcon :name="selectMode ? 'i-carbon-checkbox-checked' : 'i-carbon-checkbox'" class="h-4 w-4" />
          </button>
          <button v-if="!railCollapsed" type="button" class="icon-btn-ghost" title="刷新" @click="refreshTasks">
            <UIcon name="i-carbon-renew" class="h-4 w-4" />
          </button>
          <button type="button" class="icon-btn-ghost" :title="railCollapsed ? '展开' : '折叠'" @click="toggleRail">
            <UIcon :name="railCollapsed ? 'i-carbon-side-panel-open' : 'i-carbon-side-panel-close'" class="h-4 w-4" />
          </button>
        </div>
      </div>

      <!-- Filter panel (platform / model) -->
      <div v-if="filterOpen && !railCollapsed"
        class="space-y-2 border-b border-[var(--c-border-2)] bg-[var(--c-surface-2)] px-3 py-2.5">
        <div class="flex items-center gap-2">
          <span class="w-8 flex-shrink-0 text-[11px] text-[var(--c-fg-4)]">平台</span>
          <select v-model="filterProvider"
            class="h-7 flex-1 rounded-[4px] border border-[var(--c-border)] bg-[var(--c-surface)] px-1.5 text-[12px] text-[var(--c-fg-3)] outline-none focus:border-primary-400">
            <option :value="null">全部</option>
            <option v-for="p in filterProviderOptions" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>
        <div class="flex items-center gap-2">
          <span class="w-8 flex-shrink-0 text-[11px] text-[var(--c-fg-4)]">模型</span>
          <select v-model="filterModel"
            class="h-7 flex-1 rounded-[4px] border border-[var(--c-border)] bg-[var(--c-surface)] px-1.5 text-[12px] text-[var(--c-fg-3)] outline-none focus:border-primary-400">
            <option :value="null">全部</option>
            <option v-for="m in filterModelOptions" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
        <label class="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--c-fg-3)]">
          <input v-model="filterFavorite" type="checkbox" class="h-3.5 w-3.5 accent-[var(--ui-primary,#8b5cf6)]" />
          <UIcon name="i-carbon-star-filled" class="h-3.5 w-3.5 text-primary-600" />
          只看收藏
        </label>
        <label class="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--c-fg-3)]">
          <input v-model="filterStructured" type="checkbox" class="h-3.5 w-3.5 accent-[var(--ui-primary,#8b5cf6)]" />
          <UIcon name="i-carbon-chart-relationship" class="h-3.5 w-3.5 text-primary-600" />
          已结构化分析
        </label>
        <label class="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--c-fg-3)]">
          <input v-model="filterSensitive" type="checkbox" class="h-3.5 w-3.5 accent-[var(--ui-primary,#8b5cf6)]" />
          <UIcon name="i-carbon-search" class="h-3.5 w-3.5 text-primary-600" />
          已敏感词分析
        </label>
        <div v-if="filterActive" class="flex justify-end">
          <button type="button" class="text-[11px] text-primary-600 hover:underline" @click="clearFilter">清除筛选</button>
        </div>
      </div>

      <!-- Multi-select action bar -->
      <div v-if="selectMode && !railCollapsed"
        class="flex items-center justify-between gap-2 border-b border-[var(--c-border-2)] bg-[var(--c-surface-2)] px-3 py-2">
        <label class="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--c-fg-4)]">
          <input type="checkbox" :checked="allSelected" class="h-3.5 w-3.5 accent-[var(--ui-primary,#8b5cf6)]"
            @change="toggleSelectAll" />
          全选 ({{ selectedIds.size }})
        </label>
        <div class="flex items-center gap-1">
          <button type="button" :disabled="!selectedIds.size"
            class="inline-flex h-6 items-center gap-1 rounded-[4px] border border-[var(--c-border)] bg-[var(--c-surface)] px-2 text-[11px] text-[var(--c-fg-3)] transition hover:border-primary-400 hover:text-primary-700 disabled:opacity-40"
            @click="batchDownload">
            <UIcon name="i-carbon-download" class="h-3.5 w-3.5" /> 下载
          </button>
          <button type="button" :disabled="!selectedIds.size"
            class="inline-flex h-6 items-center gap-1 rounded-[4px] border border-[var(--c-border)] bg-[var(--c-surface)] px-2 text-[11px] text-red-500 transition hover:border-red-300 hover:bg-red-50 disabled:opacity-40"
            @click="batchDelete">
            <UIcon name="i-carbon-trash-can" class="h-3.5 w-3.5" /> 删除
          </button>
        </div>
      </div>

      <!-- 首次加载：骨架屏（仅在还没有任务数据时显示，避免误以为页面卡死） -->
      <div v-if="tasksStore.loading && !tasks.length" class="flex-1 overflow-hidden p-2">
        <div v-for="n in (railCollapsed ? 6 : 5)" :key="n"
          class="mb-1.5 animate-pulse rounded-[6px] border border-[var(--c-border-2)] bg-[var(--c-surface)]"
          :class="railCollapsed ? 'h-12' : 'h-[52px]'" />
      </div>
      <div v-else-if="!filteredTasks.length"
        class="flex flex-1 items-center justify-center px-4 py-10 text-center text-[12px] text-[var(--c-fg-4)]">
        <span v-if="!railCollapsed">{{ tasks.length ? '无匹配任务' : '暂无记录' }}</span>
      </div>
      <ul v-else-if="railCollapsed" class="scroll-area flex-1 space-y-1.5 overflow-y-auto p-2">
        <li v-for="item in filteredTasks" :key="item.id"
          class="cursor-pointer overflow-hidden rounded-[4px] border bg-[var(--c-surface)] transition" :class="activeId === item.id
            ? 'border-primary-500 ring-1 ring-primary-500'
            : 'border-[var(--c-border-2)] hover:border-[var(--c-fg-5)]'"
          :draggable="!!thumbUrl(item)" @dragstart="onTaskDragStart($event, item)"
          @mouseenter="onTaskHover($event, item)" @mouseleave="onTaskHoverLeave"
          @click="selectTask(item.id)">
          <!-- Fixed uniform height so the collapsed strip looks tidy regardless of media aspect. -->
          <div class="relative grid h-12 w-full place-items-center bg-[var(--c-surface-2)]">
            <img v-if="item.kind === 'image' && thumbUrl(item)" :src="thumbUrl(item)!"
              class="h-full w-full object-cover" loading="lazy" />
            <video v-else-if="item.kind === 'video' && thumbUrl(item)" :src="thumbUrl(item)!"
              class="h-full w-full object-cover" muted playsinline preload="metadata" />
            <UIcon v-else-if="item.kind === 'image'" name="i-carbon-image" class="h-4 w-4 text-[var(--c-fg-7)]" />
            <UIcon v-else-if="item.kind === 'video'" name="i-carbon-video" class="h-4 w-4 text-[var(--c-fg-7)]" />
            <UIcon v-else name="i-carbon-text-creation" class="h-4 w-4 text-[var(--c-fg-7)]" />
            <!-- 进行中/失败：右上角圆点（进行中主色呼吸，失败标红） -->
            <span v-if="item.status !== 'succeeded'" class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full"
              :class="item.status === 'failed' ? 'bg-red-500' : 'bg-primary-500 animate-pulse'" />
            <!-- 进行中：底部实时已消耗时长 -->
            <span v-if="item.status === 'pending' || item.status === 'running'"
              class="absolute inset-x-0 bottom-0 bg-[var(--c-surface)]/80 text-center font-mono text-[9px] leading-tight text-primary-600 backdrop-blur-sm">{{ elapsedLabel(item) }}</span>
          </div>
        </li>
      </ul>
      <div v-else class="scroll-area flex-1 overflow-y-auto p-2">
        <div v-for="g in groupedTasks" :key="g.label" class="mb-1">
          <!-- date group header -->
          <div class="sticky top-0 z-10 bg-[var(--c-surface)]/95 px-1 py-1 text-[11px] font-medium text-[var(--c-fg-5)] backdrop-blur">
            {{ g.label }}
          </div>
          <ul class="space-y-1.5">
            <li v-for="item in g.items" :key="item.id" class="group rounded-[6px] border px-2.5 py-2 transition" :class="[
              activeId === item.id && !selectMode ? 'border-primary-500 bg-primary-50' : 'border-[var(--c-border-2)] bg-[var(--c-surface)] hover:border-[var(--c-fg-5)]',
              selectMode && selectedIds.has(item.id) ? 'border-primary-500 bg-primary-50' : '',
              selectMode ? '' : 'cursor-pointer',
            ]" :draggable="!selectMode && !!thumbUrl(item)"
              @dragstart="onTaskDragStart($event, item)"
              @mouseenter="onTaskHover($event, item)" @mouseleave="onTaskHoverLeave"
              @click="selectMode ? toggleSelect(item.id) : selectTask(item.id)">
              <div class="flex items-start gap-2">
                <input v-if="selectMode" type="checkbox" :checked="selectedIds.has(item.id)"
                  class="mt-1 h-3.5 w-3.5 flex-shrink-0 accent-[var(--ui-primary,#8b5cf6)]"
                  @click.stop="toggleSelect(item.id)" />
                <div
                  class="relative grid h-9 w-12 flex-shrink-0 place-items-center overflow-hidden rounded-[4px] border border-[var(--c-border)] bg-[var(--c-surface-2)]">
                  <img v-if="item.kind === 'image' && thumbUrl(item)" :src="thumbUrl(item)!"
                    class="h-full w-full object-cover" loading="lazy" />
                  <video v-else-if="item.kind === 'video' && thumbUrl(item)" :src="thumbUrl(item)!"
                    class="h-full w-full object-cover" muted playsinline preload="metadata" />
                  <UIcon v-else-if="item.kind === 'image'" name="i-carbon-image" class="h-3.5 w-3.5 text-[var(--c-fg-7)]" />
                  <UIcon v-else-if="item.kind === 'video'" name="i-carbon-video" class="h-3.5 w-3.5 text-[var(--c-fg-7)]" />
                  <UIcon v-else name="i-carbon-text-creation" class="h-3.5 w-3.5 text-[var(--c-fg-7)]" />
                  <!-- 进行中/失败：右上角圆点（进行中主色呼吸，失败标红） -->
                  <span v-if="item.status !== 'succeeded'" class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full"
                    :class="item.status === 'failed' ? 'bg-red-500' : 'bg-primary-500 animate-pulse'" />
                </div>
                <div class="min-w-0 flex-1">
                  <!-- 第一行：平台 + 模型（收藏按钮靠右） -->
                  <div class="flex items-center gap-1.5">
                    <span class="flex-shrink-0 text-[11px] text-[var(--c-fg-3)]">{{ item.provider_name }}</span>
                    <span class="text-[var(--c-fg-7)]">·</span>
                    <span class="truncate font-mono text-[11px] text-[var(--c-fg-4)]">{{ item.model_name }}</span>
                    <button type="button"
                      class="ml-auto grid h-5 w-5 flex-shrink-0 place-items-center rounded-[4px] transition hover:bg-[var(--c-surface-3)]"
                      :class="item.favorite ? 'text-primary-600' : 'text-[var(--c-fg-7)] opacity-0 group-hover:opacity-100'"
                      :title="item.favorite ? '取消收藏' : '收藏'"
                      @click.stop="toggleTaskFavorite(item, $event)">
                      <UIcon :name="item.favorite ? 'i-carbon-star-filled' : 'i-carbon-star'" class="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <!-- 第二行：任务状态 + 结构化/敏感词分析标记 -->
                  <div class="mt-0.5 flex items-center gap-1.5">
                    <span class="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                      :class="taskStatusPillClass(item)">
                      <span class="h-1 w-1 rounded-full" :class="taskStatusDotClass(item)" />
                      {{ taskStatusLabel(item) }}
                    </span>
                    <UIcon v-if="hasStructured(item)" name="i-carbon-chart-relationship"
                      class="h-3 w-3 flex-shrink-0 text-primary-500" title="已结构化分析" />
                    <UIcon v-if="hasSensitive(item)" name="i-carbon-search"
                      class="h-3 w-3 flex-shrink-0 text-primary-500" title="已敏感词分析" />
                  </div>
                  <div
                    v-if="assetRetentionInfo(item).state === 'active' || assetRetentionInfo(item).state === 'due'"
                    class="mt-0.5 truncate text-[10px]"
                    :class="assetRetentionInfo(item).state === 'due' ? 'text-amber-600' : 'text-[var(--c-fg-6)]'"
                    :title="assetRetentionInfo(item).detail"
                  >{{ assetRetentionInfo(item).label }}，请及时下载</div>
                  <!-- 第三行：创建时间 + 已消耗/耗时（进行中实时计时） -->
                  <div class="mt-0.5 flex items-center gap-2 font-mono text-[11px] tabular-nums text-[var(--c-fg-7)]">
                    <span>{{ hhmm(item.created_at) }}</span>
                    <span>·</span>
                    <span :class="(item.status === 'pending' || item.status === 'running') ? 'text-primary-600' : ''">
                      {{ (item.status === 'pending' || item.status === 'running') ? '进行中 ' : '' }}{{ elapsedLabel(item) }}
                    </span>
                  </div>
                </div>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </aside>

    <!-- 任务概览悬浮卡：复用 TaskDetail(预览模式)，鼠标移上去保持打开 -->
    <Teleport to="body">
      <Transition name="hovercard">
        <div v-if="hoverCard" class="fixed z-[60] flex flex-col overflow-hidden rounded-[8px] border border-white/35 bg-[var(--c-surface)]/60 shadow-xl backdrop-blur-2xl backdrop-saturate-150 dark:border-white/10 dark:bg-[var(--c-surface)]/50"
          :style="hoverCardStyle" @mouseenter="onHoverCardEnter" @mouseleave="onHoverCardLeave">
          <div class="flex flex-shrink-0 items-center justify-between gap-2 border-b border-white/25 px-3 py-1.5 dark:border-white/10">
            <span class="text-[11px] font-medium text-[var(--c-fg-5)]">概览</span>
            <button type="button" class="pill-btn !h-6 !px-2 !text-[11px]" title="把本次任务的平台/模型/参数/提示词/参考素材回填到创作区"
              @click="retryTask(hoverCard.task); onHoverCardLeave()">
              <UIcon name="i-carbon-copy" class="h-3 w-3" /> 复刻参数
            </button>
          </div>
          <div class="scroll-area min-h-0 flex-1 overflow-y-auto">
            <TaskDetail :task="hoverCard.task" mode="overview" preview />
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.hovercard-enter-active,
.hovercard-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.hovercard-enter-from,
.hovercard-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
