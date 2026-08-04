<script setup lang="ts">
// 任务详情：概览（参数/成本/提示词）与网络（请求+响应，按 phase 分块）两种视图。
// 也做预览模式（任务列表 hover 卡）的只读精简版。分析结果轮询回传由父层写回 store。
import type { TaskRow } from '~~/types/api'
import { taskEndpoint } from '~~/shared/task-curl'
import { usePromptFavorites } from '~/composables/usePromptFavorites'

const props = defineProps<{ task: TaskRow; mode: 'overview' | 'network'; preview?: boolean }>()
const retention = computed(() => assetRetentionInfo(props.task))

// 预览模式（任务列表 hover 卡）：截断提示词、隐藏时间/功能按钮，只读概览。
const PREVIEW_PROMPT_MAX = 400
const displayPrompt = computed(() => {
  const p = props.task.prompt || ''
  if (props.preview && p.length > PREVIEW_PROMPT_MAX) return `${p.slice(0, PREVIEW_PROMPT_MAX)}…`
  return p || '(空)'
})

// Fullscreen via shared global viewer (overview reference assets are clickable)
const { open: openFullscreen } = useFullscreenViewer()

// Seedance 成本（仅 doubao-video 成功任务）。
const cost = computed(() => computeTaskCost(props.task))

// Prompt favorites — bookmark the task's prompt for later recall via "/".
const { add: addFavorite, remove: removeFavorite, has: hasFavorite, favorites } = usePromptFavorites()
const promptFavorited = computed(() => !!props.task.prompt && hasFavorite(props.task.prompt))
function toggleFavorite() {
  const text = props.task.prompt || ''
  if (!text.trim()) return
  if (promptFavorited.value) {
    const fav = favorites.value.find((f) => f.text === text.trim())
    if (fav) removeFavorite(fav.id)
  } else {
    addFavorite(text)
  }
}

// 分析 — 文本模型把杂乱提示词整理成结构化形式。结果渲染(highlights + segments)并持久化到任务。
interface Analysis { structured?: string; highlights?: string[]; segments?: { label: string; text: string }[] }
// 敏感词分析 — 找出可能触发审核的词并给出不改变原意的替换；corrected 为改正后完整提示词。
interface SensitiveItem { original: string; replacement: string; reason?: string }
interface Sensitive { corrected: string; items: SensitiveItem[] }
type JobType = 'structured' | 'sensitive'
interface JobState { status: 'running' | 'error'; error?: string }
// 任务上持久化的分析对象：结构化在顶层(向后兼容)，敏感词挂在 sensitive，进行中/失败挂在 jobs。
interface StoredAnalysis extends Analysis { sensitive?: Sensitive; jobs?: Partial<Record<JobType, JobState>> }

// 异步分析：结果与「进行中/失败」状态都存在任务的 analysis 字段里，刷新页面也不丢。
// 点击分析 → POST /api/tasks/{id}/analyze(后台跑) → 轮询 GET /api/tasks/{id} 直到 jobs[type] 消失。
const emit = defineEmits<{ (e: 'update:analysis', a: StoredAnalysis | null): void }>()

// 本地权威副本：初始化自任务，轮询时更新；同时回传父级以同步 store / 列表标记。
const liveAnalysis = ref<StoredAnalysis | null>((props.task.analysis as StoredAnalysis | undefined) || null)
// POST 启动失败的即时错误（与 job 错误分开）。
const startError = ref<{ structured: string | null; sensitive: string | null }>({ structured: null, sensitive: null })

const analysis = computed<Analysis | null>(() => {
  const a = liveAnalysis.value
  if (a && (a.structured || a.segments?.length)) return a
  return null
})
const sensitive = computed<Sensitive | null>(() => liveAnalysis.value?.sensitive || null)
const analyzing = computed(() => liveAnalysis.value?.jobs?.structured?.status === 'running')
const analyzingSensitive = computed(() => liveAnalysis.value?.jobs?.sensitive?.status === 'running')
const analyzeError = computed(() => startError.value.structured || liveAnalysis.value?.jobs?.structured?.error || null)
const sensitiveError = computed(() => startError.value.sensitive || liveAnalysis.value?.jobs?.sensitive?.error || null)
const hasRunningJob = computed(() => analyzing.value || analyzingSensitive.value)

// 轮询：有 running job 时每 2s 拉一次任务，把最新 analysis 同步到本地+父级。
let pollTimer: ReturnType<typeof setInterval> | null = null
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } }
async function pollOnce() {
  try {
    const fresh = await useDataSource().getTask(props.task.id)
    liveAnalysis.value = (fresh.analysis as StoredAnalysis | undefined) || null
    emit('update:analysis', liveAnalysis.value)
  } catch { /* keep trying */ }
  if (!hasRunningJob.value) stopPoll()
}
function ensurePoll() {
  if (props.preview) return // 预览卡不渲染分析，无需轮询
  if (hasRunningJob.value && !pollTimer) pollTimer = setInterval(pollOnce, 2000)
}

// 切换任务：重置本地副本并按需恢复轮询（刷新后若仍 running，自动续上）。
watch(() => props.task.id, () => {
  stopPoll()
  liveAnalysis.value = (props.task.analysis as StoredAnalysis | undefined) || null
  startError.value = { structured: null, sensitive: null }
  ensurePoll()
}, { immediate: true })
onBeforeUnmount(stopPoll)

// 启动一次后台分析。
async function startAnalysis(type: JobType) {
  if (!props.task.prompt?.trim()) return
  startError.value[type] = null
  // 乐观置 running，避免等待 POST 往返时按钮无反馈。
  liveAnalysis.value = { ...(liveAnalysis.value || {}), jobs: { ...(liveAnalysis.value?.jobs || {}), [type]: { status: 'running' } } }
  try {
    const res = await useDataSource().analyzeTask(props.task.id, type)
    liveAnalysis.value = (res.analysis as StoredAnalysis) || liveAnalysis.value
    emit('update:analysis', liveAnalysis.value)
    ensurePoll()
  } catch (err: any) {
    startError.value[type] = err?.data?.statusMessage || err?.statusMessage || err?.message || '分析启动失败'
    // 回滚乐观的 running 标记。
    const jobs = { ...(liveAnalysis.value?.jobs || {}) }
    delete jobs[type]
    liveAnalysis.value = { ...(liveAnalysis.value || {}), jobs }
  }
}
function analyzePrompt() { void startAnalysis('structured') }
function analyzeSensitive() { void startAnalysis('sensitive') }

// 把改正后的提示词按替换词切成 runs：命中替换词的片段标记为 flagged 并带上原敏感词，
// 模板里渲染成「原词(删除线) 替换词(高亮)」，其余为普通文本。
function sensitiveParts(text: string): { text: string; flagged: boolean; original?: string }[] {
  const s = sensitive.value
  if (!s?.items?.length || !text) return [{ text, flagged: false }]
  const terms = s.items
    .filter((it) => it.replacement && it.replacement.trim())
    .sort((a, b) => b.replacement.length - a.replacement.length)
  if (!terms.length) return [{ text, flagged: false }]
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(${terms.map((t) => esc(t.replacement)).join('|')})`, 'g')
  const parts: { text: string; flagged: boolean; original?: string }[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0
    if (idx > last) parts.push({ text: text.slice(last, idx), flagged: false })
    const hit = terms.find((t) => t.replacement === m[0])
    parts.push({ text: m[0], flagged: true, original: hit?.original })
    last = idx + m[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), flagged: false })
  return parts
}

// Split any text into highlighted / plain runs from analysis.highlights, so
// the重点 keywords are emphasised inline within the STRUCTURED content.
function highlightParts(text: string): { text: string; hl: boolean }[] {
  const a = analysis.value
  if (!a?.highlights?.length || !text) return [{ text, hl: false }]
  const terms = a.highlights.filter((t) => t && t.trim()).sort((x, y) => y.length - x.length)
  if (!terms.length) return [{ text, hl: false }]
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(${terms.map(esc).join('|')})`, 'g')
  const parts: { text: string; hl: boolean }[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0
    if (idx > last) parts.push({ text: text.slice(last, idx), hl: false })
    parts.push({ text: m[0], hl: true })
    last = idx + m[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), hl: false })
  return parts
}

const formatLatency = formatDuration

function formatTime(ts: number | null) {
  if (ts == null) return '—'
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// 复制 + 状态流转：点击后该按钮短暂切换到「已复制」(对勾 + 主色)，1.4s 后复原。
const copiedKey = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
function copyText(value: unknown, key = 'default') {
  let text = ''
  if (typeof value === 'string') text = value
  else { try { text = JSON.stringify(value, null, 2) } catch { text = String(value) } }
  navigator.clipboard?.writeText(text).catch(() => {})
  copiedKey.value = key
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copiedKey.value = null }, 1400)
}
onBeforeUnmount(() => { if (copiedTimer) clearTimeout(copiedTimer) })

const formatLabel = computed(() => {
  if (props.task.api_format === 'openai-sync') return 'OpenAI 兼容 · 同步'
  if (props.task.api_format === 'openai-async') return 'OpenAI 兼容 · 异步'
  if (props.task.api_format === 'xai-image') return 'xAI Imagine · 图片'
  if (props.task.api_format === 'doubao-video') return 'Seedance官方 · 异步'
  if (props.task.api_format === 'full-url') return '完整 URL · 直连'
  return props.task.api_format
})

const queueWaitMs = computed(() => {
  if (props.task.finished_at == null || props.task.latency_ms == null) return null
  const total = props.task.finished_at - props.task.created_at
  return total - props.task.latency_ms
})

const paramEntries = computed(() => Object.entries(props.task.params || {}))
const totalRefs = computed(() => {
  const r = props.task.refs
  if (!r) return 0
  return r.image.length + r.video.length + r.audio.length
})

// 与实际适配器和服务端 curl 共用同一份端点规则。
const requestEndpoint = computed(() => taskEndpoint(props.task, props.task.provider_base_url || ''))

// curl text comes from the server (so the real API key is filled in, paste-and-run).
// Refetched when the task id / payload changes or when 网络 tab is opened.
const curlText = ref('')
async function loadCurl() {
  if (props.mode !== 'network') return
  try {
    const data = await useDataSource().taskCurl(props.task.id)
    curlText.value = data?.curl || ''
  } catch {
    curlText.value = ''
  }
}
watch(() => [props.task.id, props.task.request_payload, props.mode] as const, loadCurl, { immediate: true })

// Display version truncates very long tokens (e.g. base64 data: URLs in the
// `image` field) so the <pre> stays light and switching JSON/cURL is snappy.
// Copy always uses the full `curlText`.
const curlDisplay = computed(() =>
  curlText.value.replace(/(data:[^"'\s]{40})[^"'\s]+/g, (_m, head) => `${head}…[已截断]`),
)

// 创建任务请求的展示形式：JSON / curl 切换（与左侧创作区一致）
const reqView = ref<'json' | 'curl'>('json')

const requestJsonText = computed(() => {
  const p = props.task.request_payload
  if (p == null) return ''
  try { return JSON.stringify(p, null, 2) } catch { return String(p) }
})

// 显示用截断：超长字符串（如 base64 data: URL）直接整串渲染会拖慢前端，
// 这里截短给页面看；复制/href 仍用完整值。
function truncateDisplay(v: unknown, max = 120): string {
  const s = typeof v === 'object' ? (() => { try { return JSON.stringify(v) } catch { return String(v) } })() : String(v)
  return s.length > max ? `${s.slice(0, max)}…(${s.length} 字符)` : s
}

// Async response shape from adapters: { submit|create, poll_url, polls: [latest] }.
// Per UX spec: 请求 tab shows the create request only (no intermediate polls);
// 响应 tab shows the create response immediately, then swaps to the latest
// poll response once it lands. While polling we render a "轮询中…" indicator
// inline above the response body.
const asyncShape = computed<null | {
  createResponse: unknown
  pollUrl: string | null
  latestPoll: unknown | null
  polling: boolean
}>(() => {
  const r = (props.task.response_payload || null) as any
  if (!r || typeof r !== 'object') return null
  const createResp = r.submit !== undefined ? r.submit : r.create !== undefined ? r.create : undefined
  if (createResp === undefined || !Array.isArray(r.polls)) return null
  const latest = r.polls.length ? r.polls[r.polls.length - 1] : null
  const polling = props.task.status === 'running' || props.task.status === 'pending'
  return {
    createResponse: createResp,
    pollUrl: r.poll_url || null,
    latestPoll: latest,
    polling,
  }
})

const isAsync = computed(() => asyncShape.value !== null)

// Poll endpoint (GET) shown as the second round's request for async tasks.
const pollEndpoint = computed<{ method: string; url: string } | null>(() => {
  const s = asyncShape.value
  if (!s || !s.pollUrl) return null
  return { method: 'GET', url: s.pollUrl }
})
</script>

<template>
  <div class="scroll-area h-full overflow-y-auto px-5 py-4">
    <div
      v-if="retention.state !== 'permanent'"
      class="mb-4 rounded-[6px] border px-3 py-2.5"
      :class="retention.state === 'cleaned'
        ? 'border-[var(--c-border)] bg-[var(--c-surface-2)]'
        : retention.state === 'due'
          ? 'border-amber-300 bg-amber-50/60'
          : 'border-primary-200 bg-primary-50/40'"
    >
      <div class="flex items-start gap-2">
        <UIcon
          :name="retention.state === 'cleaned' ? 'i-carbon-clean' : 'i-carbon-time'"
          class="mt-0.5 h-4 w-4 flex-shrink-0"
          :class="retention.state === 'cleaned' ? 'text-[var(--c-fg-5)]' : retention.state === 'due' ? 'text-amber-600' : 'text-primary-600'"
        />
        <div class="min-w-0">
          <div class="text-[13px] font-medium text-[var(--c-fg)]">{{ retention.label }}</div>
          <div v-if="!preview" class="mt-0.5 text-[12px] leading-relaxed text-[var(--c-fg-4)]">{{ retention.detail }}</div>
        </div>
      </div>
    </div>
    <!-- 概览 -->
    <div v-if="mode === 'overview'" class="space-y-6">
      <!-- hover 卡（预览模式）失败任务：错误信息置顶，第一眼可见 -->
      <section v-if="preview && task.error_message">
        <div class="label-uppercase mb-2">错误</div>
        <div class="rounded-[4px] border border-red-200 bg-red-50 px-3 py-2 font-mono text-[12px] text-red-700 whitespace-pre-wrap break-all">{{ task.error_message }}</div>
      </section>

      <section>
        <div class="label-uppercase mb-2">配置</div>
        <div>
          <div class="kv"><span class="kv-key">平台</span><span class="kv-val">{{ task.provider_name }}</span></div>
          <div class="kv"><span class="kv-key">模型</span><span class="kv-val">{{ task.model_name }}</span></div>
          <div class="kv"><span class="kv-key">类型</span><span class="kv-val">{{ task.kind === 'image' ? '图像' : '视频' }}</span></div>
          <div class="kv"><span class="kv-key">协议</span><span class="kv-val">{{ formatLabel }}</span></div>
          <div v-if="task.remote_task_id && !preview" class="kv">
            <span class="kv-key">远程任务 ID</span>
            <span class="kv-val flex-1">{{ task.remote_task_id }}</span>
            <button type="button" class="pill-btn" :class="copiedKey === 'remote' ? 'pill-btn-active' : ''" title="复制" @click="copyText(task.remote_task_id, 'remote')">
              <UIcon :name="copiedKey === 'remote' ? 'i-carbon-checkmark' : 'i-carbon-copy'" class="h-3.5 w-3.5" /> {{ copiedKey === 'remote' ? '已复制' : '复制' }}
            </button>
          </div>
        </div>
      </section>

      <section v-if="paramEntries.length">
        <div class="label-uppercase mb-2">参数</div>
        <div>
          <div v-for="[k, v] in paramEntries" :key="k" class="kv">
            <span class="kv-key">{{ k }}</span>
            <span class="kv-val">{{ truncateDisplay(v) }}</span>
          </div>
        </div>
      </section>

      <section>
        <div class="mb-2 flex items-center justify-between">
          <div class="label-uppercase">提示词</div>
          <div v-if="!preview" class="flex items-center gap-1.5">
            <button type="button" class="pill-btn" :disabled="analyzing || !task.prompt" title="用文本模型把杂乱提示词分析为结构化提示词" @click="analyzePrompt">
              <UIcon :name="analyzing ? 'i-carbon-circle-dash' : 'i-carbon-chart-relationship'" class="h-3.5 w-3.5" :class="analyzing ? 'animate-spin' : ''" />
              结构化分析
            </button>
            <button type="button" class="pill-btn" :disabled="analyzingSensitive || !task.prompt" title="用文本模型找出可能触发审核的敏感词并给出替换" @click="analyzeSensitive">
              <UIcon :name="analyzingSensitive ? 'i-carbon-circle-dash' : 'i-carbon-search'" class="h-3.5 w-3.5" :class="analyzingSensitive ? 'animate-spin' : ''" />
              敏感词分析
            </button>
            <button type="button" class="pill-btn-icon" :class="{ 'pill-btn-active': promptFavorited }" :title="promptFavorited ? '已收藏' : '收藏提示词'" @click="toggleFavorite">
              <UIcon :name="promptFavorited ? 'i-carbon-bookmark-filled' : 'i-carbon-bookmark'" class="h-3.5 w-3.5" />
            </button>
            <button type="button" class="pill-btn-icon" :class="copiedKey === 'prompt' ? 'pill-btn-active' : ''" title="复制提示词" @click="copyText(task.prompt, 'prompt')">
              <UIcon :name="copiedKey === 'prompt' ? 'i-carbon-checkmark' : 'i-carbon-copy'" class="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <!-- User prompt as plain text (highlighting happens in the analysis box). -->
        <div class="rounded-[4px] border border-[var(--c-border)] bg-[var(--c-surface-2)] px-3 py-2 text-[13px] leading-relaxed text-[var(--c-fg)] whitespace-pre-wrap">{{ displayPrompt }}</div>
        <p v-if="!preview && analyzeError" class="mt-1.5 text-[12px] text-red-600">{{ analyzeError }}</p>

        <!-- 结构化分析框：分析中即显示并在框内 loading；重点词在结构化内容里高亮 -->
        <div v-if="!preview && (analyzing || analysis)" class="mt-3 rounded-[6px] border border-primary-200 bg-primary-50/40 p-3">
          <div class="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-primary-700">
            <UIcon name="i-carbon-chart-relationship" class="h-4 w-4" /> 结构化分析
          </div>
          <!-- loading skeleton -->
          <div v-if="analyzing" class="flex items-center gap-2 py-3 text-[12px] text-[var(--c-fg-4)]">
            <UIcon name="i-carbon-circle-dash" class="h-4 w-4 animate-spin text-primary-500" />
            正在分析提示词…
          </div>
          <template v-else-if="analysis">
            <div v-if="analysis.segments?.length" class="space-y-1.5">
              <div v-for="(seg, i) in analysis.segments" :key="i" class="flex gap-2 text-[12px]">
                <span class="w-16 flex-shrink-0 whitespace-nowrap font-medium text-[var(--c-fg-4)]">{{ seg.label }}</span>
                <span class="min-w-0 flex-1 break-words text-[var(--c-fg)]">
                  <template v-for="(p, j) in highlightParts(seg.text)" :key="j"><mark v-if="p.hl" class="rounded-[2px] bg-primary-100 px-0.5 text-primary-800">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template>
                </span>
              </div>
            </div>
            <div v-else-if="analysis.structured" class="text-[12px] leading-relaxed text-[var(--c-fg)] whitespace-pre-wrap">{{ analysis.structured }}</div>
            <div class="mt-2 flex justify-end">
              <button type="button" class="pill-btn" :class="copiedKey === 'structured' ? 'pill-btn-active' : ''" title="复制结构化提示词" @click="copyText(analysis.structured, 'structured')">
                <UIcon :name="copiedKey === 'structured' ? 'i-carbon-checkmark' : 'i-carbon-copy'" class="h-3.5 w-3.5" /> {{ copiedKey === 'structured' ? '已复制' : '复制结构化' }}
              </button>
            </div>
          </template>
        </div>

        <p v-if="!preview && sensitiveError" class="mt-1.5 text-[12px] text-red-600">{{ sensitiveError }}</p>
        <!-- 敏感词分析框：流程同结构化分析；命中的替换处高亮(原词删除线)，复制自动取改正后内容 -->
        <div v-if="!preview && (analyzingSensitive || sensitive)" class="mt-3 rounded-[6px] border border-amber-300 bg-amber-50/50 p-3">
          <div class="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-amber-700">
            <UIcon name="i-carbon-search" class="h-4 w-4" /> 敏感词分析
          </div>
          <div v-if="analyzingSensitive" class="flex items-center gap-2 py-3 text-[12px] text-[var(--c-fg-4)]">
            <UIcon name="i-carbon-circle-dash" class="h-4 w-4 animate-spin text-amber-500" />
            正在分析敏感词…
          </div>
          <template v-else-if="sensitive">
            <div v-if="!sensitive.items.length" class="py-1 text-[12px] text-[var(--c-fg-4)]">未发现明显敏感内容。</div>
            <template v-else>
              <!-- 直接显示改正后的完整提示词：替换处「原词(删除线) 替换词(高亮)」内联呈现，无额外说明 -->
              <div class="rounded-[4px] border border-[var(--c-border)] bg-[var(--c-surface)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--c-fg)] whitespace-pre-wrap"><template
                v-for="(p, j) in sensitiveParts(sensitive.corrected)" :key="j"><template v-if="p.flagged"><span v-if="p.original" class="text-[var(--c-fg-6)] line-through decoration-red-500/70">{{ p.original }}</span><mark class="rounded-[2px] bg-amber-100 px-0.5 text-amber-800">{{ p.text }}</mark></template><template v-else>{{ p.text }}</template></template></div>
            </template>
            <div class="mt-2 flex justify-end">
              <!-- 复制自动取改正后的内容 -->
              <button type="button" class="pill-btn" :class="copiedKey === 'sensitive' ? 'pill-btn-active' : ''" title="复制改正后的提示词" @click="copyText(sensitive.corrected, 'sensitive')">
                <UIcon :name="copiedKey === 'sensitive' ? 'i-carbon-checkmark' : 'i-carbon-copy'" class="h-3.5 w-3.5" /> {{ copiedKey === 'sensitive' ? '已复制' : '复制改正' }}
              </button>
            </div>
          </template>
        </div>
      </section>

      <section v-if="!preview">
        <div class="label-uppercase mb-2">时间</div>
        <div>
          <div class="kv"><span class="kv-key">创建</span><span class="kv-val">{{ formatTime(task.created_at) }}</span></div>
          <div class="kv"><span class="kv-key">完成</span><span class="kv-val">{{ formatTime(task.finished_at) }}</span></div>
          <div class="kv"><span class="kv-key">耗时</span><span class="kv-val font-semibold text-primary-500">{{ formatLatency(task.latency_ms) }}</span></div>
          <div v-if="queueWaitMs != null && queueWaitMs > 100" class="kv">
            <span class="kv-key">额外等待</span>
            <span class="kv-val">{{ formatLatency(queueWaitMs) }}</span>
          </div>
          <div v-if="task.http_status" class="kv">
            <span class="kv-key">HTTP 状态</span>
            <span class="kv-val">{{ task.http_status }}</span>
          </div>
          <div v-if="cost" class="kv">
            <span class="kv-key">成本</span>
            <span class="kv-val group/c relative inline-flex items-center gap-1 font-semibold text-amber-600">
              {{ formatCost(cost.cny) }}
              <UIcon name="i-carbon-help" class="h-3 w-3 cursor-help opacity-70" />
              <span class="pointer-events-none absolute left-0 top-full z-30 mt-1 hidden w-max max-w-[280px] whitespace-normal rounded-[6px] border border-[var(--c-border)] bg-[var(--c-surface)] px-2.5 py-1.5 text-[11px] font-normal leading-relaxed text-[var(--c-fg-3)] shadow-wf group-hover/c:block">
                {{ cost.formula }}
              </span>
            </span>
          </div>
        </div>
      </section>

      <section v-if="totalRefs > 0">
        <div class="label-uppercase mb-2">参考素材 · {{ totalRefs }}</div>
        <div class="space-y-3">
          <div v-if="task.refs?.image?.length">
            <div class="mb-1.5 text-[12px] font-medium text-[var(--c-fg-4)]">参考图 · {{ task.refs.image.length }}</div>
            <div class="grid grid-cols-4 gap-2 sm:grid-cols-5">
              <button
                v-for="r in task.refs.image"
                :key="r.asset_id"
                type="button"
                class="group relative block aspect-square overflow-hidden rounded-[4px] border border-[var(--c-border)] bg-[var(--c-surface-2)] transition hover:border-primary-500"
                title="点击全屏查看"
                @click="openFullscreen(r.public_url, 'image')"
              >
                <img :src="r.public_url" class="h-full w-full object-cover" :alt="r.filename || ''" loading="lazy" />
                <span class="absolute inset-0 hidden place-items-center bg-black/30 group-hover:grid">
                  <UIcon name="i-carbon-zoom-in" class="h-5 w-5 text-white" />
                </span>
              </button>
            </div>
          </div>
          <div v-if="task.refs?.video?.length">
            <div class="mb-1.5 text-[12px] font-medium text-[var(--c-fg-4)]">参考视频 · {{ task.refs.video.length }}</div>
            <div class="grid grid-cols-3 gap-2">
              <button
                v-for="r in task.refs.video"
                :key="r.asset_id"
                type="button"
                class="group relative block aspect-square overflow-hidden rounded-[4px] border border-[var(--c-border)] bg-black transition hover:border-primary-500"
                title="点击全屏查看"
                @click="openFullscreen(r.public_url, 'video')"
              >
                <video :src="r.public_url" class="h-full w-full object-cover" muted playsinline preload="metadata" />
                <span class="absolute inset-0 grid place-items-center bg-black/20 transition group-hover:bg-black/40">
                  <UIcon name="i-carbon-zoom-in" class="hidden h-5 w-5 text-white group-hover:block" />
                  <UIcon name="i-carbon-play-filled-alt" class="h-6 w-6 text-white/80 group-hover:hidden" />
                </span>
              </button>
            </div>
          </div>
          <div v-if="task.refs?.audio?.length">
            <div class="mb-1.5 text-[12px] font-medium text-[var(--c-fg-4)]">参考音频 · {{ task.refs.audio.length }}</div>
            <div class="space-y-1.5">
              <div
                v-for="r in task.refs.audio"
                :key="r.asset_id"
                class="flex items-center gap-2 rounded-[4px] border border-[var(--c-border)] px-2.5 py-1.5"
              >
                <UIcon name="i-carbon-music" class="h-4 w-4 flex-shrink-0 text-[var(--c-fg-4)]" />
                <span class="w-24 flex-shrink-0 truncate text-[12px] text-[var(--c-fg)]">{{ r.filename || r.asset_id }}</span>
                <audio :src="r.public_url" controls class="h-7 flex-1" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section v-if="!preview && task.result_urls?.length">
        <div class="label-uppercase mb-2">结果 · {{ task.result_urls.length }}</div>
        <div class="space-y-1.5">
          <div
            v-for="(u, i) in task.result_urls"
            :key="i"
            class="flex items-center gap-2 rounded-[4px] border border-[var(--c-border)] px-2.5 py-1.5"
          >
            <span class="font-mono text-[11px] text-[var(--c-fg-4)]">#{{ i + 1 }}</span>
            <a :href="u" target="_blank" rel="noreferrer" class="flex-1 truncate font-mono text-[12px] text-primary-500 hover:underline">{{ truncateDisplay(u, 160) }}</a>
            <button type="button" class="pill-btn" :class="copiedKey === `url-${i}` ? 'pill-btn-active' : ''" title="复制链接" @click="copyText(u, `url-${i}`)">
              <UIcon :name="copiedKey === `url-${i}` ? 'i-carbon-checkmark' : 'i-carbon-copy'" class="h-3.5 w-3.5" /> {{ copiedKey === `url-${i}` ? '已复制' : '复制' }}
            </button>
          </div>
        </div>
      </section>

      <section v-if="!preview && task.error_message">
        <div class="label-uppercase mb-2">错误</div>
        <div class="rounded-[4px] border border-red-200 bg-red-50 px-3 py-2 font-mono text-[12px] text-red-700 whitespace-pre-wrap break-all">{{ task.error_message }}</div>
      </section>
    </div>

    <!-- 网络 — 每一轮的「请求 + 响应」成对显示在同一张卡片里。
         同步任务：单轮。异步任务：① 创建任务（请求+响应）→ 轮询中… →
         ② 查询结果（GET 请求 + 最终响应）。请求支持 JSON / cURL 切换，
         cURL 带真实 api_key 可直接复制运行。 -->
    <div v-else class="space-y-4">
      <!-- ===== Round 1: 创建任务 / 同步请求 ===== -->
      <div class="overflow-hidden rounded-[6px] border border-[var(--c-border)]">
        <div class="flex items-center justify-between border-b border-[var(--c-border)] bg-[var(--c-surface-2)] px-3 py-2">
          <span class="text-[12px] font-semibold text-[var(--c-fg)]">{{ isAsync ? '① 创建任务' : '请求 / 响应' }}</span>
          <div class="flex items-center gap-1">
            <div class="seg-toggle">
              <button type="button" class="seg-btn" :class="reqView === 'json' ? 'seg-btn-active' : ''" @click="reqView = 'json'">JSON</button>
              <button type="button" class="seg-btn" :class="reqView === 'curl' ? 'seg-btn-active' : ''" @click="reqView = 'curl'">cURL</button>
            </div>
            <button type="button" class="pill-btn" :class="copiedKey === 'request' ? 'pill-btn-active' : ''" title="复制" @click="copyText(reqView === 'curl' ? curlText : task.request_payload, 'request')">
              <UIcon :name="copiedKey === 'request' ? 'i-carbon-checkmark' : 'i-carbon-copy'" class="h-3.5 w-3.5" /> {{ copiedKey === 'request' ? '已复制' : '复制' }}
            </button>
          </div>
        </div>
        <div class="space-y-3 p-3">
          <!-- 请求 -->
          <div>
            <div class="mb-1.5 label-uppercase">请求</div>
            <div v-if="requestEndpoint" class="mb-2 flex items-center gap-2 rounded-[4px] border border-[var(--c-border)] bg-[var(--c-surface-2)] px-3 py-2 font-mono text-[12px]">
              <span class="rounded-[3px] bg-primary-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">{{ requestEndpoint.method }}</span>
              <span class="truncate text-[var(--c-fg-2)]" :title="requestEndpoint.url">{{ requestEndpoint.url }}</span>
            </div>
            <template v-if="reqView === 'json'">
              <JsonTree v-if="task.request_payload" :data="task.request_payload" :default-expand-depth="3" />
              <div v-else class="text-[13px] text-[var(--c-fg-4)]">{{ task.refs === undefined ? '正在加载 payload…' : '无 payload' }}</div>
            </template>
            <template v-else>
              <pre v-if="curlText" class="overflow-x-auto rounded-[4px] border border-[var(--c-border)] bg-[var(--c-surface-2)] px-3 py-3 font-mono text-[12px] leading-relaxed text-[var(--c-fg-2)]">{{ curlDisplay }}</pre>
              <div v-else class="text-[13px] text-[var(--c-fg-4)]">cURL 不可用</div>
            </template>
          </div>
          <div class="border-t border-dashed border-[var(--c-border-2)]" />
          <!-- 响应 -->
          <div>
            <div class="mb-1.5 label-uppercase">响应</div>
            <template v-if="isAsync && asyncShape">
              <JsonTree :data="asyncShape.createResponse" :default-expand-depth="3" />
            </template>
            <template v-else-if="task.response_payload">
              <JsonTree :data="task.response_payload" :default-expand-depth="3" />
            </template>
            <div v-else class="text-[13px] text-[var(--c-fg-4)]">暂无响应</div>
          </div>
        </div>
      </div>

      <!-- ===== 轮询中 indicator ===== -->
      <div v-if="isAsync && asyncShape?.polling" class="flex items-center gap-2 rounded-[6px] border border-primary-200 bg-primary-50 px-3 py-2 text-[12px] text-primary-700">
        <UIcon name="i-carbon-circle-dash" class="h-4 w-4 animate-spin" />
        <span>轮询中…</span>
        <span v-if="task.remote_task_id" class="ml-auto font-mono text-[11px] text-primary-600">task_id: {{ task.remote_task_id }}</span>
      </div>

      <!-- ===== Round 2: 查询结果（仅异步且已有结果） ===== -->
      <div v-if="isAsync && asyncShape?.latestPoll" class="overflow-hidden rounded-[6px] border border-[var(--c-border)]">
        <div class="flex items-center justify-between border-b border-[var(--c-border)] bg-[var(--c-surface-2)] px-3 py-2">
          <span class="text-[12px] font-semibold text-[var(--c-fg)]">② 查询结果</span>
          <button type="button" class="pill-btn" :class="copiedKey === 'poll' ? 'pill-btn-active' : ''" title="复制" @click="copyText(asyncShape.latestPoll, 'poll')">
            <UIcon :name="copiedKey === 'poll' ? 'i-carbon-checkmark' : 'i-carbon-copy'" class="h-3.5 w-3.5" /> {{ copiedKey === 'poll' ? '已复制' : '复制' }}
          </button>
        </div>
        <div class="space-y-3 p-3">
          <!-- 请求 -->
          <div>
            <div class="mb-1.5 label-uppercase">请求</div>
            <div v-if="pollEndpoint" class="flex items-center gap-2 rounded-[4px] border border-[var(--c-border)] bg-[var(--c-surface-2)] px-3 py-2 font-mono text-[12px]">
              <span class="rounded-[3px] bg-primary-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">{{ pollEndpoint.method }}</span>
              <span class="truncate text-[var(--c-fg-2)]" :title="pollEndpoint.url">{{ pollEndpoint.url }}</span>
            </div>
            <div v-else class="text-[13px] text-[var(--c-fg-4)]">轮询同一任务直至完成</div>
          </div>
          <div class="border-t border-dashed border-[var(--c-border-2)]" />
          <!-- 响应 -->
          <div>
            <div class="mb-1.5 label-uppercase">响应</div>
            <JsonTree :data="asyncShape.latestPoll" :default-expand-depth="3" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
