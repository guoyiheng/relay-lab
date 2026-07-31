<script setup lang="ts">
// Single global fullscreen overlay. Driven by useFullscreenViewer() so any
// component can open media fullscreen. Mounted once in the default layout.
const { state, close } = useFullscreenViewer()

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
        <video
          v-else-if="state.kind === 'video'"
          :key="state.url"
          :src="state.url"
          class="max-h-[92vh] max-w-[92vw] rounded-[6px] shadow-2xl"
          controls
          autoplay
          playsinline
          @click.stop
        />
        <div
          v-else
          :key="state.url"
          class="flex w-[min(90vw,520px)] flex-col items-center gap-5 rounded-[10px] bg-white/5 p-8 shadow-2xl"
          @click.stop
        >
          <UIcon name="i-carbon-music" class="h-16 w-16 text-white/70" />
          <audio :src="state.url" controls autoplay class="w-full" />
        </div>
      </Transition>
    </div>
  </Transition>
</template>
