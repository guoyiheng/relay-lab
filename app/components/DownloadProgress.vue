<script setup lang="ts">
// 底部居中的打包下载进度条。状态在 useDownloadProgress 的模块级单例，挂在 app.vue，
// 全项目共用一个实例。批量下载抓素材 + 压缩耗时长，用它给用户一个可见的进度体感。
import { computed } from 'vue'
import { useDownloadProgressState } from '~/composables/useDownloadProgress'

const state = useDownloadProgressState()

// 确定态显示真实百分比；不确定态（压缩阶段）交给流动条动画。
const pct = computed(() =>
  state.indeterminate ? 100 : Math.round((state.done / Math.max(state.total, 1)) * 100),
)
</script>

<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0 translate-y-2"
    leave-active-class="transition duration-150 ease-in"
    leave-to-class="opacity-0 translate-y-2">
    <div
      v-if="state.open"
      class="pointer-events-none fixed inset-x-0 bottom-5 z-[60] flex justify-center px-4">
      <div
        class="pointer-events-auto w-[min(420px,92vw)] rounded-[10px] border border-[var(--c-border)] bg-[var(--c-surface)] px-4 py-3 shadow-lg">
        <div class="mb-2 flex items-center gap-2">
          <UIcon
            :name="state.failed ? 'i-carbon-warning-alt' : 'i-carbon-document-download'"
            class="h-4 w-4 shrink-0"
            :class="state.failed ? 'text-error-500' : 'text-primary-600'" />
          <span class="text-[13px] font-medium text-[var(--c-fg-2)]">{{ state.title }}</span>
          <span class="ml-auto text-[12px] tabular-nums text-[var(--c-fg-4)]">
            <template v-if="!state.indeterminate && !state.failed">{{ state.done }}/{{ state.total }}</template>
          </span>
        </div>

        <!-- 进度轨道：确定态按百分比拉伸；不确定态走流动动画。 -->
        <div class="h-1.5 w-full overflow-hidden rounded-full bg-[var(--c-surface-3)]">
          <div
            v-if="!state.indeterminate"
            class="h-full rounded-full transition-[width] duration-300 ease-out"
            :class="state.failed ? 'bg-error-500' : 'bg-primary-500'"
            :style="{ width: pct + '%' }" />
          <div v-else class="dl-indeterminate h-full w-2/5 rounded-full bg-primary-500" />
        </div>

        <p v-if="state.label" class="mt-2 truncate text-[12px] text-[var(--c-fg-4)]">
          {{ state.label }}
        </p>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* 不确定态流动条：来回滑动，表达「正在处理但无法量化」。 */
@keyframes dl-slide {
  0% { transform: translateX(-120%); }
  100% { transform: translateX(320%); }
}
.dl-indeterminate {
  animation: dl-slide 1.1s ease-in-out infinite;
}
</style>
