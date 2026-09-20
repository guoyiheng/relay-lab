<script setup lang="ts">
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui'
import { formatMediaTime } from '~~/shared/media-trim'

const props = defineProps<{
  duration: number
  start: number
  end: number
  currentTime: number
  playing: boolean
  processing: boolean
  progress: string
}>()
const emit = defineEmits<{
  range: [value: { start: number; end: number }]
  start: [value: number]
  end: [value: number]
  reset: []
  play: []
  apply: []
  cancel: []
}>()
const startDraft = ref('0')
const endDraft = ref('0')
const error = ref('')
const startHandle = useTemplateRef<{ $el: HTMLElement }>('startHandle')
const endHandle = useTemplateRef<{ $el: HTMLElement }>('endHandle')
const ready = computed(() => Number.isFinite(props.duration) && props.duration > 0)
const gap = computed(() => Math.min(0.1, props.duration))
const step = computed(() => Math.min(0.01, gap.value || 0.01))
const playhead = computed(() => ready.value ? Math.min(100, Math.max(0, props.currentTime / props.duration * 100)) : 0)
watch(() => [props.start, props.end], () => {
  startDraft.value = String(Number(props.start.toFixed(3)))
  endDraft.value = String(Number(props.end.toFixed(3)))
  error.value = ''
}, { immediate: true })

function commit(field: 'start' | 'end') {
  // Vue's number input v-model can emit numbers even when the draft starts as a string.
  const raw = String(field === 'start' ? startDraft.value : endDraft.value)
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
function selectRange(values: number[] | undefined) {
  if (!values || values.length !== 2 || props.processing || !ready.value) return
  const [start, end] = values as [number, number]
  // Keep a dragged handle on its own boundary when Reka sorts crossing thumbs.
  // Restore focus after updating props so the next drag event uses that handle.
  if (start === props.end && end > props.end) {
    emit('range', { start: props.end - gap.value, end: props.end })
    void nextTick(() => startHandle.value?.$el.focus())
    return
  }
  if (end === props.start && start < props.start) {
    emit('range', { start: props.start, end: props.start + gap.value })
    void nextTick(() => endHandle.value?.$el.focus())
    return
  }
  // Send both bounds together so the parent never clamps against a stale bound.
  if (start < 0 || end > props.duration || end - start < gap.value - 1e-9) return
  emit('range', { start, end })
}
</script>

<template>
  <section class="trim-controls w-full min-w-0 shrink-0 border-t border-white/15 px-3 py-4 text-white" aria-label="截取参考素材">
    <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
      <h2 class="font-medium">截取片段</h2>
      <span class="text-xs tabular-nums text-white/70">{{ ready ? `已选 ${(end - start).toFixed(2)} 秒` : '正在读取媒体时长…' }}</span>
    </div>
    <div class="timeline-wrap">
      <SliderRoot
        :model-value="[start, end]"
        :min="0"
        :max="duration || 1"
        :step="step"
        :min-steps-between-thumbs="Math.ceil(gap / step)"
        :disabled="processing || !ready"
        thumb-alignment="overflow"
        class="trim-timeline"
        aria-label="截取时间范围"
        @update:model-value="selectRange"
      >
        <SliderTrack class="timeline-track">
          <SliderRange class="timeline-selection" />
          <div class="timeline-ticks" aria-hidden="true">
            <span v-for="tick in 41" :key="tick" :class="{ major: (tick - 1) % 10 === 0 }" />
          </div>
        </SliderTrack>
        <div v-if="ready" class="timeline-playhead" :style="{ left: `${playhead}%` }" aria-hidden="true" />
        <SliderThumb ref="startHandle" class="timeline-handle timeline-handle-start" aria-label="开始时间" :aria-valuetext="formatMediaTime(start)">
          <span class="handle-grip" aria-hidden="true" />
        </SliderThumb>
        <SliderThumb ref="endHandle" class="timeline-handle timeline-handle-end" aria-label="结束时间" :aria-valuetext="formatMediaTime(end)">
          <span class="handle-grip" aria-hidden="true" />
        </SliderThumb>
      </SliderRoot>
      <div class="timeline-scale" aria-hidden="true">
        <span v-for="fraction in [0, 0.25, 0.5, 0.75, 1]" :key="fraction">{{ formatMediaTime(duration * fraction) }}</span>
      </div>
    </div>
    <fieldset :disabled="processing || !ready" class="trim-fields">
      <div class="trim-boundary">
        <label class="trim-time-label">
          <span>开始</span>
          <input v-model="startDraft" aria-label="开始时间（秒）" type="number" min="0" :max="Math.max(0, end - gap)" step="0.01" class="trim-time" @change="commit('start')" @keydown.enter="commit('start')" />
          <span class="text-white/45">秒</span>
        </label>
        <UTooltip text="将播放位置设为开始">
          <button type="button" class="trim-icon" aria-label="将播放位置设为开始" :disabled="processing || !ready || currentTime > end - gap" @click="emit('start', currentTime)"><UIcon name="i-carbon-open-panel-left" class="size-4" /></button>
        </UTooltip>
      </div>
      <div class="trim-boundary">
        <label class="trim-time-label">
          <span>结束</span>
          <input v-model="endDraft" aria-label="结束时间（秒）" type="number" :min="start + gap" :max="duration" step="0.01" class="trim-time" @change="commit('end')" @keydown.enter="commit('end')" />
          <span class="text-white/45">秒</span>
        </label>
        <UTooltip text="将播放位置设为结束">
          <button type="button" class="trim-icon" aria-label="将播放位置设为结束" :disabled="processing || !ready || currentTime < start + gap" @click="emit('end', currentTime)"><UIcon name="i-carbon-open-panel-right" class="size-4" /></button>
        </UTooltip>
      </div>
    </fieldset>
    <div v-if="processing" class="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs" role="status" aria-live="polite">
      <span>{{ progress || '正在准备截取…' }} · 请保持页面打开</span>
      <button type="button" class="trim-button border border-white/25" @click="emit('cancel')">取消截取</button>
    </div>
    <p v-if="error" role="alert" class="mt-3 text-xs text-red-300">{{ error }}</p>
    <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-3">
      <div class="flex items-center gap-1">
        <UTooltip :text="playing ? '暂停' : '播放选区'">
          <button type="button" class="trim-icon" :aria-label="playing ? '暂停' : '播放选区'" :disabled="processing || !ready || !!error" @click="emit('play')"><UIcon :name="playing ? 'i-carbon-pause-filled' : 'i-carbon-play-filled-alt'" class="size-5" /></button>
        </UTooltip>
        <UTooltip text="重置选区">
          <button type="button" class="trim-icon" aria-label="重置选区" :disabled="processing || !ready" @click="emit('reset')"><UIcon name="i-carbon-reset" class="size-4" /></button>
        </UTooltip>
        <span class="ml-1 text-xs tabular-nums text-white/60">{{ formatMediaTime(currentTime) }}</span>
      </div>
      <button type="button" class="trim-button bg-primary-500 text-white hover:bg-primary-600" :disabled="processing || !ready || !!error || end - start < gap - 1e-9" @click="emit('apply')"><UIcon name="i-carbon-cut" class="size-4" />{{ processing ? '正在生成…' : '截取并替换' }}</button>
    </div>
  </section>
</template>

<style scoped>
.trim-controls { container-type: inline-size; letter-spacing: 0; }
.timeline-wrap { margin: 22px 20px 18px; }
.trim-timeline { position: relative; display: flex; height: 52px; align-items: center; touch-action: none; user-select: none; cursor: ew-resize; }
.timeline-track { position: relative; width: 100%; height: 44px; overflow: hidden; border-radius: 3px; background: rgb(255 255 255 / 7%); }
.timeline-selection { position: absolute; height: 100%; border-block: 2px solid var(--ui-color-primary-400); background: color-mix(in srgb, var(--ui-color-primary-400) 20%, transparent); }
.timeline-ticks { position: absolute; inset: 0; display: flex; align-items: center; justify-content: space-between; pointer-events: none; }
.timeline-ticks span { width: 1px; height: 8px; background: rgb(255 255 255 / 22%); }
.timeline-ticks .major { height: 20px; background: rgb(255 255 255 / 45%); }
.timeline-handle { --reka-slider-thumb-transform: translateX(-50%); z-index: 2; display: grid; place-items: center; width: 20px; height: 52px; border: 1px solid var(--ui-color-primary-300); border-radius: 4px; background: var(--ui-color-primary-400); cursor: ew-resize; }
.timeline-handle-start { margin-left: -10px; border-radius: 4px 0 0 4px; }
.timeline-handle-end { margin-left: 10px; border-radius: 0 4px 4px 0; }
.timeline-handle::before { content: ''; position: absolute; inset: -6px 0; }
.timeline-handle:hover, .timeline-handle:focus-visible { background: var(--ui-color-primary-300); }
.handle-grip { width: 4px; height: 18px; border-inline: 1px solid var(--ui-color-primary-950); opacity: 0.8; pointer-events: none; }
.timeline-playhead { position: absolute; top: -3px; bottom: -3px; z-index: 1; width: 1px; background: white; pointer-events: none; }
.timeline-playhead::before { content: ''; position: absolute; top: -2px; left: -3px; width: 7px; height: 7px; border-radius: 1px; background: white; }
.timeline-scale { display: flex; justify-content: space-between; margin-top: 8px; color: rgb(255 255 255 / 55%); font-size: 10px; font-variant-numeric: tabular-nums; }
.trim-fields { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; }
.trim-boundary, .trim-time-label { display: flex; align-items: center; gap: 8px; }
.trim-time-label { min-width: 0; font-size: 12px; color: rgb(255 255 255 / 70%); }
.trim-time {
  width: 5.25rem;
  min-width: 0;
  border: 1px solid rgb(255 255 255 / 25%);
  border-radius: 4px;
  background: rgb(255 255 255 / 8%);
  padding: 6px;
  text-align: center;
  color: inherit;
  font-variant-numeric: tabular-nums;
}
.trim-icon { display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0; border-radius: 4px; color: rgb(255 255 255 / 80%); }
.trim-icon:hover:not(:disabled) { background: rgb(255 255 255 / 10%); color: white; }
.trim-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 6px 12px; border-radius: 4px; font-size: 12px; }
button:active:not(:disabled) { transform: scale(0.97); }
:is(input, button, .timeline-handle):focus-visible { outline: 2px solid var(--ui-color-primary-300); outline-offset: 3px; }
:is(input, button):disabled { opacity: 0.4; cursor: not-allowed; }
.trim-timeline[data-disabled] { opacity: 0.4; cursor: not-allowed; }
.trim-timeline[data-disabled] .timeline-handle { cursor: not-allowed; }
@container (max-width: 390px) {
  .trim-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
  .trim-boundary { flex-wrap: wrap; gap: 0; }
  .trim-time-label { gap: 5px; }
  .trim-time { width: 4.5rem; }
  .trim-boundary .trim-icon { width: 28px; height: 28px; }
}
</style>
