<script setup lang="ts">
// 埋点分析页（仅 xxn 可见）：拉取 /api/analytics 事件并展示统计。
definePageMeta({ layout: 'default' })

const me = useCurrentUser()
const loading = ref(false)
const events = ref<any[]>([])

onMounted(async () => {
  if (me.value?.username !== 'xxn') {
    await navigateTo('/')
    return
  }
  await loadEvents()
})

async function loadEvents() {
  loading.value = true
  try {
    const res = await $fetch<{ events: any[] }>('/api/analytics')
    events.value = res.events
  } catch (err: any) {
    console.error('加载埋点数据失败', err)
  } finally {
    loading.value = false
  }
}

function formatTime(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function formatDuration(ms: number | null) {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

const eventTypeLabel: Record<string, string> = {
  click: '点击',
  page: '页面',
  interaction: '交互',
  action: '操作',
}

const eventNameLabel: Record<string, string> = {
  button_click: '按钮点击',
  page_view: '页面浏览',
  image_zoom: '图片放大',
  video_play: '视频播放',
  asset_download: '素材下载',
}
</script>

<template>
  <div class="mx-auto flex max-w-6xl flex-col gap-6 py-6">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-[20px] font-semibold text-[var(--c-fg)]">埋点</h1>
        <p class="mt-1 text-[13px] text-[var(--c-fg-4)]">用户行为追踪数据（仅 xxn 可见）</p>
      </div>
      <UButton color="neutral" variant="outline" :loading="loading" @click="loadEvents">
        刷新
      </UButton>
    </div>

    <div class="surface overflow-hidden">
      <div v-if="loading && !events.length" class="p-8 text-center text-[13px] text-[var(--c-fg-4)]">
        加载中...
      </div>
      <div v-else-if="!events.length" class="p-8 text-center text-[13px] text-[var(--c-fg-4)]">
        暂无埋点数据
      </div>
      <div v-else class="scroll-area max-h-[calc(100vh-200px)] overflow-y-auto">
        <table class="w-full text-left">
          <thead class="sticky top-0 bg-[var(--c-surface)]">
            <tr class="border-b border-[var(--c-border)]">
              <th class="px-4 py-2 text-[12px] font-medium text-[var(--c-fg-4)]">时间</th>
              <th class="px-4 py-2 text-[12px] font-medium text-[var(--c-fg-4)]">用户</th>
              <th class="px-4 py-2 text-[12px] font-medium text-[var(--c-fg-4)]">类型</th>
              <th class="px-4 py-2 text-[12px] font-medium text-[var(--c-fg-4)]">事件</th>
              <th class="px-4 py-2 text-[12px] font-medium text-[var(--c-fg-4)]">页面</th>
              <th class="px-4 py-2 text-[12px] font-medium text-[var(--c-fg-4)]">元素</th>
              <th class="px-4 py-2 text-[12px] font-medium text-[var(--c-fg-4)]">时长</th>
              <th class="px-4 py-2 text-[12px] font-medium text-[var(--c-fg-4)]">元数据</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in events" :key="e.id" class="border-b border-[var(--c-border-2)]">
              <td class="px-4 py-2 text-[12px] font-mono text-[var(--c-fg-4)]">{{ formatTime(e.created_at) }}</td>
              <td class="px-4 py-2 text-[12px] text-[var(--c-fg)]">{{ e.username }}</td>
              <td class="px-4 py-2">
                <span class="rounded-[2px] bg-primary-50 px-1.5 py-0.5 text-[11px] text-primary-700">
                  {{ eventTypeLabel[e.event_type] || e.event_type }}
                </span>
              </td>
              <td class="px-4 py-2 text-[12px] text-[var(--c-fg)]">
                {{ eventNameLabel[e.event_name] || e.event_name }}
              </td>
              <td class="px-4 py-2 text-[12px] text-[var(--c-fg-4)]">{{ e.page || '-' }}</td>
              <td class="px-4 py-2 text-[12px] text-[var(--c-fg-4)]">{{ e.element || '-' }}</td>
              <td class="px-4 py-2 text-[12px] font-mono text-[var(--c-fg-4)]">{{ formatDuration(e.duration_ms) }}</td>
              <td class="px-4 py-2 text-[12px] text-[var(--c-fg-4)]">
                <code v-if="e.metadata" class="rounded-[2px] bg-[var(--c-surface-2)] px-1.5 py-0.5 text-[10px]">
                  {{ JSON.stringify(e.metadata).slice(0, 50) }}{{ JSON.stringify(e.metadata).length > 50 ? '...' : '' }}
                </code>
                <span v-else>-</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
