<script setup lang="ts">
// Reference assets are kept LOCAL until the task is created — files are not
// uploaded to the DB on add (item 10). A pending item carries its File + an
// object-URL preview; on submit() the page uploads pending files (dedup'd by
// the server's sha256) and swaps in real ids. Existing uploads / generated
// assets dragged in keep their id directly.
export interface UploadItem {
  id: string            // upload id, or '' while pending local file
  kind: 'image' | 'video' | 'audio'
  filename: string | null
  public_url: string    // server url, or blob: object-url while pending
  file?: File           // present only for pending local files
  pending?: boolean
  sig?: string          // dedup signature (name|size|lastModified or url)
}

interface RefsState {
  image: UploadItem[]
  video: UploadItem[]
  audio: UploadItem[]
}

interface RefLimits {
  image: number
  video: number
  audio: number
}

const props = withDefaults(defineProps<{
  modelValue: RefsState
  limits: RefLimits
  videoMaxHeight?: number  // 0 = no limit; else reference videos must be ≤ this px (short side)
  videoMaxCap?: number     // absolute ceiling (highest output tier, e.g. 1080); above this a video truly can't fit
  // 离线模式：视频体积大不落 IndexedDB，参考视频只允许 web URL 添加，禁止本地上传。
  offline?: boolean
}>(), {
  videoMaxHeight: 0,
  videoMaxCap: 0,
  offline: false,
})

const emit = defineEmits<{
  (e: 'update:modelValue', v: RefsState): void
  // Reference video's short side exceeds the current output cap. Ask the parent
  // to raise the output resolution to fit (instead of dropping the video).
  // Parent replies by raising videoMaxHeight; if it can't, it leaves it and the
  // video is then removed on the next check.
  (e: 'request-resolution', shortSide: number): void
}>()

const fileInput = ref<HTMLInputElement | null>(null)
const error = ref<string | null>(null)
const dragOver = ref(false)

const totalUsed = computed(
  () => props.modelValue.image.length + props.modelValue.video.length + props.modelValue.audio.length,
)
const totalMax = computed(() => props.limits.image + props.limits.video + props.limits.audio)
const canAdd = computed(() => totalUsed.value < totalMax.value)

const acceptAttr = computed(() => {
  const parts: string[] = []
  if (props.limits.image > 0) parts.push('image/*')
  if (props.limits.video > 0) parts.push('video/*')
  if (props.limits.audio > 0) parts.push('audio/*')
  return parts.join(',')
})

function kindOfMime(mime: string): 'image' | 'video' | 'audio' | null {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return null
}

function kindLabel(k: string) {
  return ({ image: '图像', video: '视频', audio: '音频' } as Record<string, string>)[k] || k
}

function sigOf(item: UploadItem): string {
  if (item.id) return `id:${item.id}`
  if (item.file) return `file:${item.file.name}|${item.file.size}|${item.file.lastModified}`
  return `url:${item.public_url}`
}

function hasDup(k: 'image' | 'video' | 'audio', sig: string): boolean {
  return props.modelValue[k].some((i) => sigOf(i) === sig)
}

function triggerPick() {
  if (!canAdd.value) return
  fileInput.value?.click()
}

function onFileInput(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files?.length) addLocalFiles(Array.from(input.files))
  input.value = ''
}

// Add local files as PENDING items (no upload yet). Dedup within the strip.
function addLocalFiles(files: File[]) {
  error.value = null
  const next: RefsState = {
    image: [...props.modelValue.image],
    video: [...props.modelValue.video],
    audio: [...props.modelValue.audio],
  }
  for (const file of files) {
    const k = kindOfMime(file.type)
    if (!k || props.limits[k] === 0) { error.value = `不支持的文件类型：${file.name}`; continue }
    // 离线：参考视频只能填 web URL（本地大文件不入库）。
    if (props.offline && k === 'video') { error.value = '离线模式参考视频请用「视频链接」添加'; continue }
    if (next[k].length >= props.limits[k]) { error.value = `${kindLabel(k)}已达上限 ${props.limits[k]}`; continue }
    const sig = `file:${file.name}|${file.size}|${file.lastModified}`
    if (next[k].some((i) => sigOf(i) === sig)) continue // dedup
    next[k].push({
      id: '',
      kind: k,
      filename: file.name,
      public_url: URL.createObjectURL(file),
      file,
      pending: true,
      sig,
    })
    // Async-validate reference video resolution against the output limit; if it
    // exceeds, remove it and warn (the push above keeps UX snappy).
    if (k === 'video' && props.videoMaxHeight > 0) {
      const added = next[k][next[k].length - 1]
      if (added) void enforceVideoLimit(sig, added.public_url)
    }
  }
  emit('update:modelValue', next)
}

// Probe a video URL's resolution = the SHORTER side (loadedmetadata), 0 on
// failure. A vertical 720p clip is 720×1280, so its "resolution" is 720 (the
// short side), NOT videoHeight (1280) — comparing height would wrongly flag it.
function probeVideoShortSide(url: string): Promise<number> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = () => {
      const w = v.videoWidth || 0
      const h = v.videoHeight || 0
      resolve(w && h ? Math.min(w, h) : (h || w))
    }
    v.onerror = () => resolve(0)
    v.src = url
  })
}
// Check a just-added video ref against the allowed output resolution.
//  - within current cap → ok
//  - exceeds cap but ≤ absolute ceiling → ask parent to raise output resolution
//    to fit (keep the video; the requirement is to auto-bump, not drop)
//  - exceeds the ceiling (max tier) → genuinely can't fit, remove + warn
async function enforceVideoLimit(sig: string, url: string) {
  const short = await probeVideoShortSide(url)
  if (short <= 0 || short <= props.videoMaxHeight) { error.value = null; return }
  const ceiling = props.videoMaxCap || props.videoMaxHeight
  if (short <= ceiling) {
    // Parent will raise the output resolution to the lowest tier ≥ short.
    emit('request-resolution', short)
    error.value = null
    return
  }
  error.value = `参考视频分辨率 ${short}p 超过最高生成分辨率 ${ceiling}p，已移除`
  const item = props.modelValue.video.find((i) => sigOf(i) === sig)
  if (item) remove(item)
}

function remove(item: UploadItem) {
  if (item.pending && item.public_url.startsWith('blob:')) URL.revokeObjectURL(item.public_url)
  const filterK = (arr: UploadItem[]) => arr.filter((i) => sigOf(i) !== sigOf(item))
  emit('update:modelValue', {
    image: filterK(props.modelValue.image),
    video: filterK(props.modelValue.video),
    audio: filterK(props.modelValue.audio),
  })
}

function onDrop(event: DragEvent) {
  dragOver.value = false
  // Ignore internal reorder drags (handled per-tile).
  if (event.dataTransfer?.getData('application/x-relay-reorder')) return
  if (!canAdd.value) return
  // Internal asset drag (task list / preview) → add by url/id (no upload yet).
  const internal = event.dataTransfer?.getData('application/x-relay-asset')
  if (internal) {
    try {
      const asset = JSON.parse(internal) as { source: string; id: string; kind: 'image' | 'video' | 'audio'; url: string; filename: string | null }
      addExternalAsset(asset)
      return
    } catch { /* fall through */ }
  }
  const files = Array.from(event.dataTransfer?.files || [])
  if (files.length) addLocalFiles(files)
}

// External asset (already on the server: an upload id, or a generated url).
// Stored locally; generated urls are imported lazily at submit time.
function addExternalAsset(asset: { source: string; id: string; kind: 'image' | 'video' | 'audio'; url: string; filename: string | null }) {
  const k = asset.kind
  if (props.limits[k] === 0) { error.value = `当前模型不支持${kindLabel(k)}素材`; return }
  if (props.modelValue[k].length >= props.limits[k]) { error.value = '已达该类型上限'; return }
  // upload source → known id; generated → mark pending-import via file=undefined + remote url
  const isUpload = asset.source === 'upload'
  const item: UploadItem = isUpload
    ? { id: asset.id, kind: k, filename: asset.filename, public_url: asset.url, sig: `id:${asset.id}` }
    : { id: '', kind: k, filename: asset.filename, public_url: asset.url, pending: true, sig: `url:${asset.url}` }
  if (hasDup(k, item.sig!)) return
  error.value = null
  emit('update:modelValue', { ...props.modelValue, [k]: [...props.modelValue[k], item] })
  if (k === 'video' && props.videoMaxHeight > 0) void enforceVideoLimit(item.sig!, item.public_url)
}

// 通过 web URL 添加参考视频（离线模式：Seedance 也要求 web URL）。作为 pending 远端项，
// 提交时由 DataSource.resolveRefIds 登记（离线只存 URL 元数据，不下载）。
const urlAdding = ref(false)
const urlInput = ref('')
function submitUrl() {
  const url = urlInput.value.trim()
  if (!url) return
  if (!/^https?:\/\//i.test(url)) { error.value = '请输入 http/https 视频链接'; return }
  if (props.limits.video === 0) { error.value = '当前模型不支持视频素材'; return }
  if (props.modelValue.video.length >= props.limits.video) { error.value = `视频已达上限 ${props.limits.video}`; return }
  const sig = `url:${url}`
  if (hasDup('video', sig)) { urlInput.value = ''; urlAdding.value = false; return }
  error.value = null
  const item: UploadItem = { id: '', kind: 'video', filename: null, public_url: url, pending: true, sig }
  emit('update:modelValue', { ...props.modelValue, video: [...props.modelValue.video, item] })
  urlInput.value = ''
  urlAdding.value = false
}

// Public method (called by parent): add an asset chosen via @ mention.
defineExpose({ addExternalAsset, addLocalFiles })

const allItems = computed<UploadItem[]>(() => [
  ...props.modelValue.image,
  ...props.modelValue.video,
  ...props.modelValue.audio,
])

// ── drag-to-reorder within the strip ──────────────────────────
const dragIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)
function onItemDragStart(e: DragEvent, index: number) {
  dragIndex.value = index
  e.dataTransfer!.effectAllowed = 'move'
  // mark so the strip's file-drop handler ignores internal reorder drags
  e.dataTransfer!.setData('application/x-relay-reorder', '1')
}
function onItemDragOver(e: DragEvent, index: number) {
  if (dragIndex.value === null) return
  e.preventDefault()
  dragOverIndex.value = index
}
function onItemDrop(index: number) {
  const from = dragIndex.value
  dragIndex.value = null
  dragOverIndex.value = null
  if (from === null || from === index) return
  const flat = [...allItems.value]
  const [moved] = flat.splice(from, 1)
  if (!moved) return
  flat.splice(index, 0, moved)
  // Rebuild per-kind arrays preserving the new flat order.
  emit('update:modelValue', {
    image: flat.filter((i) => i.kind === 'image'),
    video: flat.filter((i) => i.kind === 'video'),
    audio: flat.filter((i) => i.kind === 'audio'),
  })
}
function onItemDragEnd() {
  dragIndex.value = null
  dragOverIndex.value = null
}

function kindTag(k: 'image' | 'video' | 'audio') {
  return ({ image: '图', video: '视', audio: '音' } as const)[k]
}
// Per-kind 1-based index of an item at flat position `flatIdx` — matches the
// 图片N numbering used by the prompt chips.
function kindIndex(item: UploadItem, flatIdx: number): number {
  let n = 0
  for (let i = 0; i <= flatIdx; i++) if (allItems.value[i]?.kind === item.kind) n++
  return n
}
function kindIcon(k: 'image' | 'video' | 'audio') {
  return ({ image: 'i-carbon-image', video: 'i-carbon-video', audio: 'i-carbon-music' } as const)[k]
}

const summary = computed(() => {
  const parts: string[] = []
  if (props.limits.image > 0) parts.push(`图 ${props.modelValue.image.length}/${props.limits.image}`)
  if (props.limits.video > 0) parts.push(`视 ${props.modelValue.video.length}/${props.limits.video}`)
  if (props.limits.audio > 0) parts.push(`音 ${props.modelValue.audio.length}/${props.limits.audio}`)
  return parts.join(' · ')
})

// ── Paste-to-upload (item 6): listen for Cmd/Ctrl+V images on the strip ──
function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  const files: File[] = []
  for (const it of items) {
    if (it.kind === 'file') {
      const f = it.getAsFile()
      if (f) files.push(f)
    }
  }
  if (files.length) {
    e.preventDefault()
    addLocalFiles(files)
  }
}
</script>

<template>
  <div>
    <div class="mb-1.5 flex items-center justify-between">
      <span class="text-[14px] font-medium text-[var(--c-fg-2)]">参考素材</span>
      <span class="font-mono text-[11px] text-[var(--c-fg-4)]">{{ summary }}</span>
    </div>
    <div class="scroll-area flex gap-2 overflow-x-auto rounded-[4px] outline-none" tabindex="0"
      @dragover.prevent="dragOver = true" @dragleave="dragOver = false" @drop.prevent="onDrop($event)" @paste="onPaste">
      <div v-for="(item, ii) in allItems" :key="item.sig || item.public_url"
        class="group relative h-20 w-20 flex-shrink-0 cursor-grab overflow-hidden rounded-[4px] border bg-[var(--c-surface-2)] transition active:cursor-grabbing"
        :class="dragOverIndex === ii && dragIndex !== ii ? 'border-primary-500 ring-2 ring-primary-500/30' : 'border-[var(--c-border)]'"
        draggable="true"
        @dragstart="onItemDragStart($event, ii)"
        @dragover="onItemDragOver($event, ii)"
        @drop.stop.prevent="onItemDrop(ii)"
        @dragend="onItemDragEnd">
        <span
          class="absolute left-1 top-1 z-10 inline-flex items-center gap-0.5 rounded-[2px] bg-primary-500 px-1 py-0.5 leading-none text-white shadow-sm">
          <UIcon :name="kindIcon(item.kind)" class="h-2.5 w-2.5" />
          <span class="text-[9px] font-semibold">{{ kindTag(item.kind) }}{{ kindIndex(item, ii) }}</span>
        </span>
        <img v-if="item.kind === 'image'" :src="item.public_url" class="h-full w-full object-cover"
          :alt="item.filename || ''" />
        <video v-else-if="item.kind === 'video'" :src="item.public_url" class="h-full w-full object-cover" muted
          playsinline />
        <div v-else class="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-center">
          <UIcon name="i-carbon-music" class="h-5 w-5 text-[var(--c-fg-4)]" />
          <span class="truncate text-[9px] text-[var(--c-fg-4)]">{{ item.filename }}</span>
        </div>
        <button type="button"
          class="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-black/80 group-hover:flex"
          :aria-label="`移除 ${item.filename || item.id}`" @click="remove(item)">
          <UIcon name="i-carbon-close" class="h-3 w-3" />
        </button>
      </div>
      <button v-if="canAdd" type="button"
        class="flex h-20 w-20 flex-shrink-0 flex-col items-center justify-center gap-0.5 rounded-[4px] border border-dashed text-[var(--c-fg-4)] transition"
        :class="dragOver
          ? 'border-primary-500 bg-primary-50'
          : 'border-[var(--c-border)] hover:border-primary-500 hover:bg-primary-50/40'" @click="triggerPick">
        <UIcon name="i-carbon-add" class="h-5 w-5" />
        <span class="text-[10px]">{{ offline ? '图片' : '添加' }}</span>
      </button>
      <!-- 视频链接添加：离线模式参考视频的唯一入口（Seedance 亦要求 web URL）。 -->
      <button v-if="canAdd && limits.video > 0 && !urlAdding" type="button"
        class="flex h-20 w-20 flex-shrink-0 flex-col items-center justify-center gap-0.5 rounded-[4px] border border-dashed border-[var(--c-border)] text-[var(--c-fg-4)] transition hover:border-primary-500 hover:bg-primary-50/40"
        @click="urlAdding = true">
        <UIcon name="i-carbon-link" class="h-5 w-5" />
        <span class="text-[10px]">视频链接</span>
      </button>
      <div v-if="urlAdding" class="flex h-20 w-56 flex-shrink-0 flex-col justify-center gap-1 rounded-[4px] border border-primary-500 bg-primary-50/40 p-2">
        <input v-model="urlInput" type="url" placeholder="粘贴 https 视频链接" autofocus
          class="w-full rounded-[3px] border border-[var(--c-border)] bg-[var(--c-surface)] px-2 py-1 text-[12px] outline-none focus:border-primary-500"
          @keydown.enter.prevent="submitUrl" @keydown.esc="urlAdding = false; urlInput = ''" />
        <div class="flex gap-1">
          <button type="button" class="seg-btn seg-btn-active flex-1 text-center active:scale-95" @click="submitUrl">添加</button>
          <button type="button" class="seg-btn flex-1 text-center active:scale-95" @click="urlAdding = false; urlInput = ''">取消</button>
        </div>
      </div>
    </div>
    <p v-if="error" class="mt-1 text-[12px] text-red-600">{{ error }}</p>
    <input ref="fileInput" type="file" multiple :accept="acceptAttr" class="hidden" @change="onFileInput" />
  </div>
</template>
