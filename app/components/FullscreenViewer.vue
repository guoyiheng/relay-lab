<script setup lang="ts">
// Single global fullscreen overlay. Driven by useFullscreenViewer() so any
// component can open media fullscreen. Mounted once in the default layout.
const { state, close } = useFullscreenViewer()
const mediaEl = ref<HTMLMediaElement | null>(null)
const mediaDuration = ref(0)
const trimInput = ref('')

watch(() => [state.url, state.kind, state.trimSeconds] as const, () => {
  trimInput.value = state.trimSeconds == null ? '' : String(state.trimSeconds)
  mediaDuration.value = 0
})

function applyTrim(value: string) {
  trimInput.value = value
  const parsed = Number(value)
  const seconds = value.trim() === '' || parsed <= 0 || !Number.isFinite(parsed)
    ? null
    : Math.min(3600, parsed)
  state.trimSeconds = seconds
  state.onTrim?.(seconds)
  if (mediaEl.value && seconds != null && mediaEl.value.currentTime >= seconds) {
    mediaEl.value.currentTime = 0
  }
}

function onMediaMetadata(e: Event) {
  const el = e.currentTarget as HTMLMediaElement
  mediaDuration.value = Number.isFinite(el.duration) ? el.duration : 0
}

function onMediaTimeUpdate(e: Event) {
  const seconds = state.trimSeconds
  const el = e.currentTarget as HTMLMediaElement
  if (seconds != null && el.currentTime >= seconds) {
    el.pause()
    el.currentTime = 0
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition duration-150 ease-in"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="state.url"
      class="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur-sm"
      @click="close"
    >
      <!-- top bar -->
      <div class="absolute inset-x-0 top-0 flex items-center justify-end gap-2 bg-gradient-to-b from-black/60 to-transparent px-5 py-4">
        <a
          :href="state.url"
          target="_blank"
          rel="noreferrer"
          class="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
          title="在新标签打开"
          @click.stop
        >
          <UIcon name="i-carbon-launch" class="h-5 w-5" />
        </a>
        <button
          type="button"
          class="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
          title="关闭 (Esc)"
          @click.stop="close"
        >
          <UIcon name="i-carbon-close" class="h-5 w-5" />
        </button>
      </div>

      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0 scale-95"
        enter-to-class="opacity-100 scale-100"
      >
        <img
          v-if="state.kind === 'image'"
          :key="state.url"
          :src="state.url"
          class="max-h-[92vh] max-w-[92vw] rounded-[6px] object-contain shadow-2xl"
          @click.stop
        />
        <div v-else-if="state.kind === 'video'" :key="state.url" class="flex max-w-[92vw] flex-col items-center gap-3" @click.stop>
          <video
            ref="mediaEl"
            :src="state.url"
            class="max-h-[78vh] max-w-[92vw] rounded-[6px] shadow-2xl"
            controls
            autoplay
            playsinline
            @loadedmetadata="onMediaMetadata"
            @timeupdate="onMediaTimeUpdate"
          />
          <label class="flex w-full max-w-[520px] items-center justify-between gap-3 text-[12px] text-white/80">
            <span>截取时长（秒）</span>
            <input
              :value="trimInput"
              type="number"
              min="0"
              max="3600"
              step="0.1"
              placeholder="完整"
              class="w-28 rounded border border-white/20 bg-white/10 px-2 py-1 text-right text-white outline-none placeholder:text-white/40 focus:border-white/60"
              @input="applyTrim(($event.target as HTMLInputElement).value)"
            />
          </label>
          <p class="w-full max-w-[520px] text-[11px] text-white/50">
            输入 0 或留空表示完整播放<span v-if="mediaDuration"> · 原始 {{ mediaDuration.toFixed(1) }} 秒</span>
          </p>
        </div>
        <div
          v-else
          :key="state.url"
          class="flex w-[min(90vw,520px)] flex-col items-center gap-5 rounded-[10px] bg-white/5 p-8 shadow-2xl"
          @click.stop
        >
          <UIcon name="i-carbon-music" class="h-16 w-16 text-white/70" />
          <audio
            ref="mediaEl"
            :src="state.url"
            controls
            autoplay
            class="w-full"
            @loadedmetadata="onMediaMetadata"
            @timeupdate="onMediaTimeUpdate"
          />
          <label class="flex w-full items-center justify-between gap-3 text-[12px] text-white/80">
            <span>截取时长（秒）</span>
            <input
              :value="trimInput"
              type="number"
              min="0"
              max="3600"
              step="0.1"
              placeholder="完整"
              class="w-28 rounded border border-white/20 bg-white/10 px-2 py-1 text-right text-white outline-none placeholder:text-white/40 focus:border-white/60"
              @input="applyTrim(($event.target as HTMLInputElement).value)"
            />
          </label>
          <p class="w-full text-[11px] text-white/50">
            输入 0 或留空表示完整播放<span v-if="mediaDuration"> · 原始 {{ mediaDuration.toFixed(1) }} 秒</span>
          </p>
        </div>
      </Transition>
    </div>
  </Transition>
</template>
