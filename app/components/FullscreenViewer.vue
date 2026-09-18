<script setup lang="ts">
// 全局媒体查看器。视频/音频默认保持暂停，用户可以先选区，再手动播放。
const { state, close } = useFullscreenViewer()
const mediaEl = ref<HTMLMediaElement | null>(null)
const mediaDuration = ref(0)
const trimStart = ref(0)
const trimEnd = ref(0)
const currentTime = ref(0)
const playing = ref(false)

function emitSelection() {
  const full = trimStart.value <= 0 && (!mediaDuration.value || trimEnd.value >= mediaDuration.value - 0.05)
  state.trimStartSeconds = full ? null : trimStart.value
  state.trimEndSeconds = full ? null : trimEnd.value
  state.trimSeconds = full ? null : trimEnd.value
  state.onTrim?.(full ? null : { start: trimStart.value, end: trimEnd.value })
}
function setStart(value: number) {
  trimStart.value = Math.max(0, Math.min(value, trimEnd.value - Math.min(0.1, mediaDuration.value)))
  emitSelection()
  if (mediaEl.value && mediaEl.value.currentTime < trimStart.value) mediaEl.value.currentTime = trimStart.value
}
function setEnd(value: number) {
  trimEnd.value = Math.min(mediaDuration.value, Math.max(value, trimStart.value + Math.min(0.1, mediaDuration.value)))
  emitSelection()
  if (mediaEl.value && mediaEl.value.currentTime >= trimEnd.value) mediaEl.value.currentTime = trimStart.value
}
function resetSelection() {
  trimStart.value = 0
  trimEnd.value = mediaDuration.value
  currentTime.value = 0
  emitSelection()
  if (mediaEl.value) mediaEl.value.currentTime = 0
}
function onMediaMetadata(e: Event) {
  const el = e.currentTarget as HTMLMediaElement
  mediaDuration.value = Number.isFinite(el.duration) ? el.duration : 0
  trimStart.value = Math.max(0, Math.min(state.trimStartSeconds ?? 0, mediaDuration.value))
  const savedEnd = state.trimEndSeconds ?? state.trimSeconds
  trimEnd.value = savedEnd != null ? Math.max(trimStart.value + Math.min(0.1, mediaDuration.value), Math.min(savedEnd, mediaDuration.value)) : mediaDuration.value
  el.currentTime = trimStart.value
  currentTime.value = trimStart.value
}
function onMediaPlay(e: Event) {
  const el = e.currentTarget as HTMLMediaElement
  playing.value = true
  if (el.currentTime < trimStart.value) el.currentTime = trimStart.value
}
function onMediaPause() { playing.value = false }
function onMediaTimeUpdate(e: Event) {
  const el = e.currentTarget as HTMLMediaElement
  currentTime.value = el.currentTime
  if (trimEnd.value > 0 && el.currentTime >= trimEnd.value) {
    el.pause()
    el.currentTime = trimStart.value
    currentTime.value = trimStart.value
  }
}
function playSelection() {
  if (!mediaEl.value) return
  if (mediaEl.value.currentTime < trimStart.value || mediaEl.value.currentTime >= trimEnd.value) mediaEl.value.currentTime = trimStart.value
  if (playing.value) mediaEl.value.pause()
  else void mediaEl.value.play()
}
watch(() => [state.url, state.kind] as const, () => {
  mediaDuration.value = 0
  trimStart.value = state.trimStartSeconds ?? 0
  trimEnd.value = state.trimEndSeconds ?? 0
  currentTime.value = trimStart.value
  playing.value = false
})
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close() }
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Transition enter-active-class="transition duration-200 ease-out" enter-from-class="opacity-0" enter-to-class="opacity-100" leave-active-class="transition duration-150 ease-in" leave-from-class="opacity-100" leave-to-class="opacity-0">
    <div v-if="state.url" class="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur-sm" @click="close">
      <div class="absolute inset-x-0 top-0 flex items-center justify-end gap-2 bg-gradient-to-b from-black/60 to-transparent px-5 py-4">
        <a :href="state.url" target="_blank" rel="noreferrer" class="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20" title="在新标签打开" @click.stop><UIcon name="i-carbon-launch" class="h-5 w-5" /></a>
        <button type="button" class="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20" title="关闭 (Esc)" @click.stop="close"><UIcon name="i-carbon-close" class="h-5 w-5" /></button>
      </div>
      <Transition enter-active-class="transition duration-200 ease-out" enter-from-class="opacity-0 scale-95" enter-to-class="opacity-100 scale-100">
        <img v-if="state.kind === 'image'" :key="state.url" :src="state.url" class="max-h-[92vh] max-w-[92vw] rounded-[6px] object-contain shadow-2xl" @click.stop />
        <div v-else-if="state.kind === 'video'" :key="state.url" class="flex max-w-[92vw] flex-col items-center gap-3" @click.stop>
          <video ref="mediaEl" :src="state.url" class="max-h-[70vh] max-w-[92vw] rounded-[6px] shadow-2xl" controls playsinline @loadedmetadata="onMediaMetadata" @play="onMediaPlay" @pause="onMediaPause" @timeupdate="onMediaTimeUpdate" />
          <MediaTrimControls :duration="mediaDuration" :start="trimStart" :end="trimEnd" :current-time="currentTime" :playing="playing" @start="setStart" @end="setEnd" @reset="resetSelection" @play="playSelection" />
        </div>
        <div v-else :key="state.url" class="flex w-[min(90vw,560px)] flex-col items-center gap-5 rounded-[10px] bg-white/5 p-8 shadow-2xl" @click.stop>
          <UIcon name="i-carbon-music" class="h-16 w-16 text-white/70" />
          <audio ref="mediaEl" :src="state.url" controls class="w-full" @loadedmetadata="onMediaMetadata" @play="onMediaPlay" @pause="onMediaPause" @timeupdate="onMediaTimeUpdate" />
          <MediaTrimControls :duration="mediaDuration" :start="trimStart" :end="trimEnd" :current-time="currentTime" :playing="playing" @start="setStart" @end="setEnd" @reset="resetSelection" @play="playSelection" />
        </div>
      </Transition>
    </div>
  </Transition>
</template>
