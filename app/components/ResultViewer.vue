<script setup lang="ts">
// 结果预览区：把任务的生成结果（图/视/文本）渲染出来，支持全屏与埋点。
import type { TaskRow } from '~~/types/api'
import { trackImageZoom, trackVideoPlay } from '~/composables/useAnalytics'

const props = defineProps<{ task: TaskRow | null }>()

// Resilient result URLs: prefer the persisted result_urls, but if a task is
// succeeded with an empty list (older rows, or an extractor gap) fall back to
// scraping the response_payload — shared with the console rail via composable.
const resultUrls = computed<string[]>(() => taskResultUrls(props.task))

// Fullscreen via shared global viewer (overlay + Esc handled globally)
const { open: openFullscreen } = useFullscreenViewer()
const { isSyncing, syncTask } = useTaskSync()

const needsVideoFetch = computed(() => props.task?.kind === 'video' && props.task.status !== 'succeeded')
const canFetchVideo = computed(() => needsVideoFetch.value && !!props.task?.remote_task_id)

// Drag a generated result into the creation area's reference uploader.
function onAssetDragStart(ev: DragEvent, url: string) {
  if (!props.task || !ev.dataTransfer) return
  ev.dataTransfer.effectAllowed = 'copy'
  ev.dataTransfer.setData('application/x-relay-asset', JSON.stringify({
    source: 'generated',
    id: `task:${props.task.id}:0`,
    kind: props.task.kind,
    url,
    filename: null,
  }))
}

function onImageZoom(url: string) {
  trackImageZoom(url, { task_id: props.task?.id, kind: props.task?.kind })
  openFullscreen(url, 'image')
}

function onVideoPlay(url: string) {
  trackVideoPlay(url, { task_id: props.task?.id })
}

function onVideoFullscreen(url: string) {
  trackVideoPlay(url, { task_id: props.task?.id, fullscreen: true })
  openFullscreen(url, 'video')
}
</script>

<template>
  <div v-if="task" class="flex h-full min-h-0 flex-col">
    <div class="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--c-surface-2)] p-5">
      <template v-if="task.assets_cleaned_at && task.kind !== 'text'">
        <div class="flex max-w-xl flex-col items-center gap-3 text-center">
          <UIcon name="i-carbon-clean" class="h-10 w-10 text-[var(--c-fg-6)]" />
          <div class="text-[16px] font-medium text-[var(--c-fg)]">素材已清理</div>
          <div class="text-[13px] leading-relaxed text-[var(--c-fg-4)]">
            {{ task.assets_cleanup_reason || '素材已按 7 天保留策略自动清理，任务记录仍然保留。' }}
          </div>
        </div>
      </template>
      <!-- 文本 / Chat 结果 — markdown 渲染 + 代码高亮 -->
      <template v-else-if="task.status === 'succeeded' && task.kind === 'text'">
        <div class="w-full max-w-3xl self-start">
          <div class="rounded-[8px] border border-[var(--c-border)] bg-[var(--c-surface)] px-4 py-3">
            <MarkdownView v-if="task.result_text" :source="task.result_text" />
            <span v-else class="text-[14px] text-[var(--c-fg-4)]">(空响应)</span>
          </div>
        </div>
      </template>
      <template v-else-if="task.status === 'succeeded' && task.kind === 'image' && resultUrls.length">
        <div
          class="grid w-full max-w-5xl gap-3"
          :class="resultUrls.length === 1 ? 'grid-cols-1' : 'grid-cols-2 lg:grid-cols-3'"
        >
          <div
            v-for="(url, i) in resultUrls"
            :key="i"
            class="group relative overflow-hidden rounded-[8px] border border-[var(--c-border)] bg-[var(--c-surface)]"
          >
            <img :src="url" class="mx-auto block max-h-[72vh] w-auto max-w-full object-contain" draggable="true" @dragstart="onAssetDragStart($event, url)" />
            <!-- corner semi-transparent fullscreen icon -->
            <button
              type="button"
              class="absolute right-2 top-2 z-10 grid h-8 w-8 place-items-center rounded-[5px] bg-black/40 text-white backdrop-blur-sm transition active:scale-90 hover:bg-black/80"
              title="全屏查看"
              @click="onImageZoom(url)"
            >
              <UIcon name="i-carbon-maximize" class="h-4 w-4" />
            </button>
          </div>
        </div>
      </template>
      <template v-else-if="task.status === 'succeeded' && task.kind === 'video' && resultUrls.length">
        <div class="flex w-full max-w-4xl flex-col gap-3">
          <div
            v-for="(url, i) in resultUrls"
            :key="i"
            class="group relative overflow-hidden rounded-[8px] border border-[var(--c-border)] bg-black"
          >
            <!-- expired video: don't request it, show a placeholder -->
            <div v-if="isVideoExpired(task, url)" class="flex aspect-video w-full flex-col items-center justify-center gap-2 bg-[var(--c-surface-2)] text-center">
              <UIcon name="i-carbon-time" class="h-8 w-8 text-[var(--c-fg-6)]" />
              <div class="text-[13px] font-medium text-[var(--c-fg-3)]">视频已过期</div>
              <div class="text-[11px] text-[var(--c-fg-6)]">Seedance 视频链接仅保留 24 小时</div>
            </div>
            <template v-else>
              <video :src="url" class="max-h-[72vh] w-full" controls playsinline draggable="true" @dragstart="onAssetDragStart($event, url)" @play="onVideoPlay(url)" />
              <!-- corner semi-transparent fullscreen icon -->
              <button
                type="button"
                class="absolute right-2 top-2 z-10 grid h-8 w-8 place-items-center rounded-[5px] bg-black/40 text-white backdrop-blur-sm transition active:scale-90 hover:bg-black/80"
                title="全屏查看"
                @click.stop="onVideoFullscreen(url)"
              >
                <UIcon name="i-carbon-maximize" class="h-4 w-4" />
              </button>
            </template>
          </div>
        </div>
      </template>
      <!-- 音频结果 -->
      <template v-else-if="task.status === 'succeeded' && task.kind === 'audio' && resultUrls.length">
        <div class="flex w-full max-w-2xl flex-col gap-3">
          <div
            v-for="(url, i) in resultUrls"
            :key="i"
            class="overflow-hidden rounded-[8px] border border-[var(--c-border)] bg-[var(--c-surface)] p-4 shadow-sm"
          >
            <div class="mb-3 flex items-center justify-between">
              <div class="flex items-center gap-2.5">
                <div class="grid h-8 w-8 place-items-center rounded-full bg-primary-50 text-primary-600">
                  <UIcon name="i-carbon-volume-up" class="h-4 w-4" />
                </div>
                <div>
                  <div class="text-[13px] font-medium text-[var(--c-fg)]">{{ task.model_name || '音频结果' }}</div>
                  <div class="text-[11px] text-[var(--c-fg-5)]">生成音频 #{{ i + 1 }}</div>
                </div>
              </div>
              <a
                :href="url"
                download
                target="_blank"
                class="inline-flex items-center gap-1 rounded-[4px] border border-[var(--c-border)] bg-[var(--c-surface-2)] px-2.5 py-1 text-[12px] text-[var(--c-fg-3)] transition hover:border-[var(--c-fg-5)]"
                title="下载音频"
              >
                <UIcon name="i-carbon-download" class="h-3.5 w-3.5" />
                <span>下载</span>
              </a>
            </div>
            <audio :src="url" class="w-full" controls playsinline preload="metadata" draggable="true" @dragstart="onAssetDragStart($event, url)" />
          </div>
        </div>
      </template>
      <template v-else-if="task.status === 'failed'">
        <div class="flex max-w-xl flex-col items-center gap-3 text-center">
          <UIcon name="i-carbon-warning-alt" class="h-10 w-10 text-red-500" />
          <div class="text-[16px] font-medium text-[var(--c-fg)]">请求失败</div>
          <div class="break-all text-[13px] text-[var(--c-fg-4)]">{{ task.error_message || '未知错误' }}</div>
        </div>
      </template>
      <template v-else-if="task.status === 'running' || task.status === 'pending'">
        <div class="flex flex-col items-center gap-3 text-center">
          <UIcon name="i-carbon-circle-dash" class="h-7 w-7 animate-spin text-primary-500" />
          <div class="text-[16px] font-medium text-[var(--c-fg)]">{{ task.status === 'running' ? '请求中…' : '排队中…' }}</div>
        </div>
      </template>
      <template v-else>
        <div class="text-[13px] text-[var(--c-fg-4)]">无结果</div>
      </template>

      <!-- 视频只要尚未成功，就始终保留主动拉取入口；没有远程 ID 时保留按钮但置灰，
           避免后台提交尚未落库或已丢失时用户误以为可以查询。 -->
      <div v-if="needsVideoFetch" class="absolute bottom-5 left-0 right-0 flex justify-center px-5">
        <button
          type="button"
          class="pill-btn inline-flex items-center gap-1.5 px-3 py-1.5"
          :disabled="!canFetchVideo || isSyncing(task.id)"
          :title="canFetchVideo ? '向平台主动拉取一次视频状态' : '暂无远程任务 ID，暂时无法拉取视频'"
          @click="syncTask(task)"
        >
          <UIcon
            :name="isSyncing(task.id) ? 'i-carbon-circle-dash' : 'i-carbon-download'"
            class="h-4 w-4"
            :class="{ 'animate-spin': isSyncing(task.id) }"
          />
          {{ isSyncing(task.id) ? '正在拉取…' : '手动拉取视频' }}
        </button>
      </div>
    </div>
  </div>

  <div v-else class="flex h-full flex-col items-center justify-center gap-3 bg-[var(--c-surface-2)] text-center">
    <UIcon name="i-carbon-image" class="h-10 w-10 text-[var(--c-fg-7)]" />
    <div class="text-[14px] text-[var(--c-fg-4)]">选择平台与模型，输入提示词后开始测试</div>
  </div>
</template>
