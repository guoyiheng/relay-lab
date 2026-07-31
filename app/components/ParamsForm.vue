<script setup lang="ts">
// 参数表单：按模型 kind + api_format 动态渲染对应参数（比例/分辨率/时长/开关等）。
// 值以 formParams 对象双向绑定，patch() 局部更新，交给父层持久化到 localStorage。
import type { ApiFormat, ModelKind } from '~~/types/api'
import { getDataMode } from '~/composables/useDataSource'

interface UploadItem {
  id: string
  kind: 'image' | 'video' | 'audio'
  filename: string | null
  public_url: string
  file?: File
  pending?: boolean
  sig?: string
}

interface RefsState {
  image: UploadItem[]
  video: UploadItem[]
  audio: UploadItem[]
}

const props = defineProps<{
  modelValue: Record<string, unknown>
  refs: RefsState
  apiFormat: ApiFormat | null
  kind: ModelKind | null
}>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: Record<string, unknown>): void
  (e: 'update:refs', v: RefsState): void
}>()


// Per-format reference asset limits.
// Seedance video: 9 image + 3 video + 3 audio (commit 277f351).
// xAI image editing: up to 3 source images, no video/audio.
// Generic OpenAI image: up to 4 reference images, no video/audio.
// OpenAI video: not yet supported.
const refLimits = computed(() => {
  if (props.apiFormat === 'doubao-video' && props.kind === 'video') {
    return { image: 9, video: 3, audio: 3 }
  }
  if (props.apiFormat === 'xai-image' && props.kind === 'image') {
    return { image: 3, video: 0, audio: 0 }
  }
  if ((props.apiFormat === 'openai-sync' || props.apiFormat === 'openai-async') && props.kind === 'image') {
    return { image: 4, video: 0, audio: 0 }
  }
  return { image: 0, video: 0, audio: 0 }
})
const showAnyRefs = computed(() => {
  const l = refLimits.value
  return l.image > 0 || l.video > 0 || l.audio > 0
})

// Ordered: portrait → square → landscape, matching how creative tools display them
const RATIOS = ['9:16', '3:4', '1:1', '4:3', '16:9'] as const
const XAI_RATIOS = ['auto', '9:20', '9:19.5', '9:16', '1:2', '2:3', '3:4', '1:1', '4:3', '3:2', '2:1', '16:9', '19.5:9', '20:9'] as const
const XAI_RESOLUTIONS = ['1k', '2k'] as const
const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const
// OpenAI-image: a single "K" tier maps to the standard UHD 16:9 anchor.
// 1K = 1920x1080, 2K = 2560x1440, 4K = 3840x2160 (longest side anchor).
// Other ratios are computed against this longest side.
const IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const
const DURATIONS = [4, 5, 6, 8, 10, 12, 15]

function patch(updates: Record<string, unknown>) {
  emit('update:modelValue', { ...props.modelValue, ...updates })
}

function clearKey(key: string) {
  const next = { ...props.modelValue }
  delete next[key]
  emit('update:modelValue', next)
}

const isVideoSeedance = computed(() => props.apiFormat === 'doubao-video' && props.kind === 'video')
const isImageXAI = computed(() => props.apiFormat === 'xai-image' && props.kind === 'image')
const isImageOpenAI = computed(() => (props.apiFormat === 'openai-sync' || props.apiFormat === 'openai-async') && props.kind === 'image')
const isVideoOpenAI = computed(() => (props.apiFormat === 'openai-sync' || props.apiFormat === 'openai-async') && props.kind === 'video')
const isText = computed(() => props.kind === 'text')

const temperature = computed(() => Number(props.modelValue.temperature ?? 1))

const ratio = computed(() => String(props.modelValue.ratio ?? '9:16'))
const xaiAspectRatio = computed(() => String(props.modelValue.aspect_ratio ?? 'auto'))
const xaiResolution = computed(() => String(props.modelValue.resolution ?? '1k').toLowerCase())
const videoResolution = computed(() => String(props.modelValue.resolution ?? '480p'))
// Reference videos must not exceed the selected output resolution. Map the
// resolution tier → max pixel height; 0 = no limit (non-seedance).
const refVideoMaxHeight = computed(() => {
  if (!isVideoSeedance.value) return 0
  return ({ '480p': 480, '720p': 720, '1080p': 1080 } as Record<string, number>)[videoResolution.value] || 0
})
// Absolute ceiling = the highest output tier. Reference videos above this can't
// fit any output and are removed; at/below it we auto-raise the output instead.
const VIDEO_RES_TIERS: { res: string; px: number }[] = [
  { res: '480p', px: 480 },
  { res: '720p', px: 720 },
  { res: '1080p', px: 1080 },
]
const refVideoMaxCap = computed(() => (isVideoSeedance.value ? 1080 : 0))
// A reference video's short side exceeds the current output resolution: raise
// the output to the lowest tier that fits (≥ shortSide), so the video is kept
// instead of dropped. e.g. upload 720p while output=480p → bump output to 720p.
function onRequestResolution(shortSide: number) {
  if (!isVideoSeedance.value) return
  const fit = VIDEO_RES_TIERS.find((t) => t.px >= shortSide)
  if (fit && fit.px > (refVideoMaxHeight.value || 0)) {
    patch({ resolution: fit.res })
  }
}
const imageResolution = computed(() => {
  const r = props.modelValue.image_resolution
  if (r && IMAGE_RESOLUTIONS.includes(String(r) as typeof IMAGE_RESOLUTIONS[number])) return String(r)
  return '1K'
})
const duration = computed(() => Number(props.modelValue.duration ?? 6))
const size = computed(() => String(props.modelValue.size ?? ''))
const n = computed(() => Number(props.modelValue.n ?? 1))
const generateAudio = computed(() => props.modelValue.generate_audio !== false)
const watermark = computed(() => !!props.modelValue.watermark)
// 「参考走素材库」：参考素材先入 Seedance 素材库再以 asset:// 引用，避免真人/违规拦截。
// 仅 Seedance 视频 + 有参考素材时才有意义。
const useAssetLibrary = computed(() => !!props.modelValue.use_asset_library)
const hasAnyRef = computed(() => props.refs.image.length + props.refs.video.length + props.refs.audio.length > 0)


function setCustomNumber(key: string, raw: string) {
  const trimmed = raw.trim()
  if (!trimmed) return clearKey(key)
  patch({ [key]: Number(trimmed) })
}

// ---------- OpenAI image: ratio × resolution → pixel size ----------
const RESOLUTION_LONGEST_SIDE: Record<string, number> = { '1K': 1920, '2K': 2560, '4K': 3840 }

function computeImageSize(ratioStr: string, resTier: string): string {
  const [a, b] = ratioStr.split(':').map(Number)
  const longest = RESOLUTION_LONGEST_SIDE[resTier] ?? 1920
  if (!a || !b) return `${longest}x${longest}`
  const big = Math.max(a, b)
  const small = Math.min(a, b)
  // Round to nearest multiple of 8 — keeps 16:9 → 1920x1080, 2560x1440, 3840x2160 exact.
  const shortSide = Math.round((small / big) * longest / 8) * 8
  return a >= b ? `${longest}x${shortSide}` : `${shortSide}x${longest}`
}

function pickImageRatio(r: string) {
  patch({ ratio: r, image_resolution: imageResolution.value, size: computeImageSize(r, imageResolution.value) })
}

function pickImageResolution(res: string) {
  patch({ ratio: ratio.value, image_resolution: res, size: computeImageSize(ratio.value, res) })
}

// 离线模式：参考视频只能填 web URL（透传给 UnifiedReferenceUpload 禁本地视频上传）。
// 用 mounted ref 而非 computed：getDataMode 读 localStorage，SSR 恒 online，避免水合不匹配。
const isOffline = ref(false)
onMounted(() => { isOffline.value = getDataMode() === 'offline' })

</script>

<template>
  <div class="space-y-4">
    <!-- 参考素材（置顶；不同格式上限不同；图/视/音 共用一个滚动条带） -->
    <UnifiedReferenceUpload
      v-if="showAnyRefs"
      :model-value="refs"
      :limits="refLimits"
      :video-max-height="refVideoMaxHeight"
      :video-max-cap="refVideoMaxCap"
      :offline="isOffline"
      @update:model-value="(v) => emit('update:refs', v)"
      @request-resolution="onRequestResolution"
    />

    <!-- Seedance / Doubao 视频 -->
    <template v-if="isVideoSeedance">
      <div>
        <div class="field-label">比例</div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="r in RATIOS"
            :key="r"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-1 text-[12px] transition"
            :class="ratio === r
              ? 'border-primary-500 bg-primary-50 text-primary-700'
              : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
            @click="patch({ ratio: r })"
          >
            <AspectIcon :ratio="r" />
            <span>{{ r }}</span>
          </button>
        </div>
      </div>
      <div>
        <div class="field-label">分辨率</div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="r in VIDEO_RESOLUTIONS"
            :key="r"
            type="button"
            class="rounded-[4px] border px-2.5 py-1 text-[12px] transition"
            :class="videoResolution === r
              ? 'border-primary-500 bg-primary-50 text-primary-700'
              : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
            @click="patch({ resolution: r })"
          >{{ r }}</button>
        </div>
      </div>
      <div>
        <div class="field-label">时长</div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="d in DURATIONS"
            :key="d"
            type="button"
            class="rounded-[4px] border px-2.5 py-1 text-[12px] transition"
            :class="duration === d
              ? 'border-primary-500 bg-primary-50 text-primary-700'
              : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
            @click="patch({ duration: d })"
          >{{ d }}s</button>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <label class="flex items-center justify-between rounded-[4px] border border-[var(--c-border)] px-3 py-1.5">
          <span class="text-[12px] text-[var(--c-fg-2)]">声音</span>
          <USwitch size="xs" :model-value="generateAudio" @update:model-value="(v: boolean) => patch({ generate_audio: v })" />
        </label>
        <label class="flex items-center justify-between rounded-[4px] border border-[var(--c-border)] px-3 py-1.5">
          <span class="text-[12px] text-[var(--c-fg-2)]">水印</span>
          <USwitch size="xs" :model-value="watermark" @update:model-value="(v: boolean) => patch({ watermark: v })" />
        </label>
      </div>
      <label v-if="hasAnyRef"
        class="flex items-center justify-between rounded-[4px] border border-[var(--c-border)] px-3 py-1.5">
        <span class="text-[12px] text-[var(--c-fg-2)]">参考走素材库</span>
        <USwitch size="xs" :model-value="useAssetLibrary" @update:model-value="(v: boolean) => patch({ use_asset_library: v })" />
      </label>
    </template>

    <!-- xAI Imagine · 文生图 / 图生图 -->
    <template v-else-if="isImageXAI">
      <div>
        <div class="field-label">比例</div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="r in XAI_RATIOS"
            :key="r"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-1 text-[12px] transition"
            :class="xaiAspectRatio === r
              ? 'border-primary-500 bg-primary-50 text-primary-700'
              : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
            @click="patch({ aspect_ratio: r })"
          >
            <AspectIcon v-if="r !== 'auto'" :ratio="r" />
            <span>{{ r === 'auto' ? '自动' : r }}</span>
          </button>
        </div>
        <p v-if="refs.image.length" class="field-hint">图生图选择“自动”时，输出会跟随第一张参考图比例。</p>
      </div>
      <div>
        <div class="field-label">分辨率</div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="r in XAI_RESOLUTIONS"
            :key="r"
            type="button"
            class="rounded-[4px] border px-2.5 py-1 text-[12px] uppercase transition"
            :class="xaiResolution === r
              ? 'border-primary-500 bg-primary-50 text-primary-700'
              : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
            @click="patch({ resolution: r })"
          >{{ r }}</button>
        </div>
      </div>
      <div>
        <div class="field-label">数量</div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="num in [1, 2, 3, 4]"
            :key="num"
            type="button"
            class="rounded-[4px] border px-2.5 py-1 text-[12px] transition"
            :class="n === num
              ? 'border-primary-500 bg-primary-50 text-primary-700'
              : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
            @click="patch({ n: num })"
          >×{{ num }}</button>
        </div>
      </div>
    </template>

    <!-- OpenAI 兼容 · 图像 -->
    <template v-else-if="isImageOpenAI">
      <div>
        <div class="field-label">比例</div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="r in RATIOS"
            :key="r"
            type="button"
            class="inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-1 text-[12px] transition"
            :class="ratio === r
              ? 'border-primary-500 bg-primary-50 text-primary-700'
              : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
            @click="pickImageRatio(r)"
          >
            <AspectIcon :ratio="r" />
            <span>{{ r }}</span>
          </button>
        </div>
      </div>
      <div>
        <div class="field-label">分辨率</div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="r in IMAGE_RESOLUTIONS"
            :key="r"
            type="button"
            class="rounded-[4px] border px-2.5 py-1 text-[12px] transition"
            :class="imageResolution === r
              ? 'border-primary-500 bg-primary-50 text-primary-700'
              : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
            @click="pickImageResolution(r)"
          >{{ r }}</button>
        </div>
      </div>
      <div>
        <div class="field-label">数量</div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="num in [1, 2, 3, 4]"
            :key="num"
            type="button"
            class="rounded-[4px] border px-2.5 py-1 text-[12px] transition"
            :class="n === num
              ? 'border-primary-500 bg-primary-50 text-primary-700'
              : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
            @click="patch({ n: num })"
          >×{{ num }}</button>
        </div>
      </div>
    </template>

    <!-- OpenAI 兼容 · 视频 -->
    <template v-else-if="isVideoOpenAI">
      <div>
        <div class="field-label">尺寸</div>
        <UInput
          :model-value="size"
          placeholder="例如 1280x720"
          size="sm"
         
          @update:model-value="(v: string) => patch({ size: v })"
        />
      </div>
      <div>
        <div class="field-label">时长 (秒)</div>
        <UInput
          :model-value="String(duration)"
          type="number"
          size="sm"
         
          @update:model-value="(v: string) => setCustomNumber('duration', v)"
        />
      </div>
    </template>

    <!-- 文本 / Chat 模型（gpt-5.5 等） -->
    <template v-else-if="isText">
      <div>
        <div class="field-label">Temperature</div>
        <div class="flex items-center gap-3">
          <input
            type="range" min="0" max="2" step="0.1"
            :value="temperature"
            class="h-1.5 flex-1 cursor-pointer accent-[var(--color-primary-500)]"
            @input="(e) => patch({ temperature: Number((e.target as HTMLInputElement).value) })"
          />
          <span class="w-8 text-right font-mono text-[13px] tabular-nums text-[var(--c-fg-3)]">{{ temperature.toFixed(1) }}</span>
        </div>
        <p class="field-hint">越低越确定，越高越发散。</p>
      </div>
    </template>

    <template v-else>
      <div class="rounded-[4px] border border-dashed border-[var(--c-border)] px-4 py-6 text-center text-[13px] text-[var(--c-fg-4)]">
        选择平台与模型后将显示对应参数
      </div>
    </template>
  </div>
</template>
