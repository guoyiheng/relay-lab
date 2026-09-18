<script setup lang="ts">
import { formatMediaTime } from '~~/shared/media-trim'

const props = defineProps<{
  duration: number
  start: number
  end: number
  currentTime: number
  playing: boolean
  processing: boolean
}>()
const emit = defineEmits<{
  start: [value: number]
  end: [value: number]
  reset: []
  play: []
  apply: []
}>()
const startDraft = ref('0')
const endDraft = ref('0')
const error = ref('')
const ready = computed(() => props.duration > 0)
const gap = computed(() => Math.min(0.1, props.duration))
const selectedStyle = computed(() => ({
  left: `${ready.value ? props.start / props.duration * 100 : 0}%`,
  width: `${ready.value ? (props.end - props.start) / props.duration * 100 : 100}%`,
}))
watch(() => [props.start, props.end], () => {
  startDraft.value = String(Number(props.start.toFixed(3)))
  endDraft.value = String(Number(props.end.toFixed(3)))
  error.value = ''
}, { immediate: true })

function commit(field: 'start' | 'end') {
  const raw = field === 'start' ? startDraft.value : endDraft.value
  const value = raw.trim() ? Number(raw) : NaN
  if (!Number.isFinite(value) || value < 0 || value > props.duration) {
    error.value = `请输入 0 到 ${props.duration.toFixed(3)} 之间的秒数`
    return
  }
  if ((field === 'start' && value > props.end - gap.value) || (field === 'end' && value < props.start + gap.value)) {
    error.value = '结束时间必须晚于开始时间，至少间隔 0.1 秒'
    return
  }
  error.value = ''
  if (field === 'start') emit('start', value)
  else emit('end', value)
}
function slide(field: 'start' | 'end', event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (field === 'start') emit('start', Math.min(value, props.end - gap.value))
  else emit('end', Math.max(value, props.start + gap.value))
}
</script>

<template>
  <section class="trim-controls w-full rounded-lg border border-white/15 bg-white/[0.06] p-4 text-white" aria-label="截取预览区间">
    <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
      <h2 class="font-medium">截取预览区间</h2>
      <span class="text-xs tabular-nums text-white/70">{{ ready ? `已选 ${(end - start).toFixed(1)} 秒 / 共 ${duration.toFixed(1)} 秒` : '正在读取媒体时长…' }}</span>
    </div>
    <div class="relative my-4 h-2 overflow-hidden rounded-full bg-white/15" aria-hidden="true">
      <div class="absolute inset-y-0 rounded-full bg-primary-400" :style="selectedStyle" />
      <div v-if="ready" class="absolute inset-y-0 w-0.5 bg-white" :style="{ left: `${Math.min(100, currentTime / duration * 100)}%` }" />
    </div>
    <div class="grid gap-4 sm:grid-cols-2">
      <div>
        <label class="flex items-center justify-between gap-2 text-xs">
          <span>开始时间（秒）</span>
          <input v-model="startDraft" type="number" min="0" :max="Math.max(0, end - gap)" step="0.1" :disabled="!ready" class="trim-time" @change="commit('start')" />
        </label>
        <input :value="start" type="range" min="0" :max="duration || 1" step="0.001" :disabled="!ready" aria-label="拖动选择开始时间" :aria-valuetext="formatMediaTime(start)" class="trim-range" @input="slide('start', $event)" />
        <button type="button" class="trim-link" :disabled="!ready || currentTime > end - gap" @click="emit('start', currentTime)">将当前进度设为开始</button>
      </div>
      <div>
        <label class="flex items-center justify-between gap-2 text-xs">
          <span>结束时间（秒）</span>
          <input v-model="endDraft" type="number" :min="start + gap" :max="duration" step="0.1" :disabled="!ready" class="trim-time" @change="commit('end')" />
        </label>
        <input :value="end" type="range" min="0" :max="duration || 1" step="0.001" :disabled="!ready" aria-label="拖动选择结束时间" :aria-valuetext="formatMediaTime(end)" class="trim-range" @input="slide('end', $event)" />
        <button type="button" class="trim-link" :disabled="!ready || currentTime < start + gap" @click="emit('end', currentTime)">将当前进度设为结束</button>
      </div>
    </div>
    <p v-if="error" role="alert" class="mt-3 text-xs text-red-300">{{ error }}</p>
    <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-3">
      <span class="text-xs tabular-nums text-white/70">{{ formatMediaTime(start) }} → {{ formatMediaTime(end) }}</span>
      <div class="flex gap-2">
        <button type="button" class="trim-button border border-white/25 text-white/85 hover:bg-white/10" :disabled="!ready" @click="emit('reset')">重置</button>
        <button type="button" class="trim-button border border-white/25 text-white/85 hover:bg-white/10" :disabled="!ready || !!error || processing" @click="emit('play')">{{ playing ? '暂停播放' : '播放选区' }}</button>
        <button type="button" class="trim-button bg-primary-500 text-white hover:bg-primary-600" :disabled="!ready || !!error || processing || end - start < 0.1" @click="emit('apply')">{{ processing ? '正在生成…' : '截取并替换参考' }}</button>
      </div>
    </div>
    <p class="mt-3 text-[11px] leading-relaxed text-white/60">可拖动滑块或输入秒数。点击“截取并替换参考”后，会生成缩短后的新文件并替换当前参考素材。</p>
  </section>
</template>

<style scoped>
.trim-time {
  width: 6rem;
  border: 1px solid rgb(255 255 255 / 25%);
  border-radius: 4px;
  background: rgb(255 255 255 / 8%);
  padding: 6px 8px;
  color: inherit;
  font-variant-numeric: tabular-nums;
}
.trim-range { width: 100%; height: 30px; margin-top: 4px; accent-color: var(--color-primary-400, #60a5fa); cursor: pointer; }
.trim-link { min-height: 28px; color: rgb(255 255 255 / 75%); font-size: 11px; text-decoration: underline; text-underline-offset: 3px; }
.trim-link:hover { color: white; }
.trim-button { min-height: 36px; padding: 6px 12px; border-radius: 4px; font-size: 12px; }
:is(input, button):focus-visible { outline: 2px solid #93c5fd; outline-offset: 3px; }
:is(input, button):disabled { opacity: 0.4; cursor: not-allowed; }
</style>
