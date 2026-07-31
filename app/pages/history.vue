<script setup lang="ts">
// 历史页：所有测试记录的列表 + 统计概览，点开某条走 Modal 复用控制台的详情视图。
import type { Provider, Model, TaskRow, ModelKind } from '~~/types/api'
import { useProvidersStore } from '~/stores/providers'

interface ProviderWithModels extends Provider {
  models: Model[]
}

interface StatsRow {
  provider_id: number | null
  provider_name: string
  api_format: string
  kind: ModelKind
  model_id: number | null
  model_name: string
  total: number
  succeeded: number
  failed: number
  avg_latency_ms: number | null
  last_run_at: number | null
  success_rate: number
}

const providersStore = useProvidersStore()
const historyStore = useHistoryStore()
const notify = useNotify()
const confirm = useConfirm()
// 历史页平台顺序统一按名称排序（#5）。
const providers = computed(() => providersStore.byName as ProviderWithModels[])
const tasks = computed(() => historyStore.tasks)
const stats = computed(() => historyStore.stats as StatsRow[])
const loading = computed(() => historyStore.loading)

const filterProvider = ref<number | null>(null)
const filterKind = ref<'image' | 'video' | null>(null)
const filterStatus = ref<'succeeded' | 'failed' | null>(null)

// Detail dialog state — opens a full task viewer (preview / overview / request / response)
// reusing the console's ResultViewer + TaskDetail components.
type DetailTab = 'preview' | 'overview' | 'network'
const detailTab = ref<DetailTab>('preview')
const detailTask = ref<TaskRow | null>(null)
const detailLoading = ref(false)
const detailOpen = computed({
  get: () => detailTask.value !== null,
  set: (v: boolean) => { if (!v) detailTask.value = null },
})
function closeDetail() { detailTask.value = null }
const detailTabItems = [
  { slot: 'preview', label: '预览' },
  { slot: 'overview', label: '概览' },
  { slot: 'network', label: '网络' },
]

async function openDetail(id: number) {
  detailLoading.value = true
  detailTab.value = 'preview'
  try {
    detailTask.value = await useDataSource().getTask(id)
  } finally {
    detailLoading.value = false
  }
}

const KIND_OPTIONS = [
  { value: null, label: '全部类型' },
  { value: 'image', label: '图像' },
  { value: 'video', label: '视频' },
]
const STATUS_OPTIONS = [
  { value: null, label: '全部状态' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
]


async function reload(force = false) {
  // Tasks depend on filters, stats are global — both cached in the history store
  // (re-entering the page reuses them). providers come from the shared store too.
  await Promise.all([
    historyStore.load({
      provider_id: filterProvider.value,
      kind: filterKind.value,
      status: filterStatus.value,
    }, force),
    providersStore.loadAll(),
  ])
}

// 筛选变化 → 走缓存 load（筛选签名变则自动重拉 tasks）。
watch([filterProvider, filterKind, filterStatus], () => reload())
onMounted(() => reload())

// Unified duration formatter (shared composable).
const formatLatency = formatDuration

// 任务成本：seedance 内置费率；其他模型按其定价（需匹配 model）。
function costOf(t: TaskRow) {
  const m = providers.value.flatMap((p) => p.models).find((mm) => mm.id === t.model_id) || null
  return computeTaskCost(t, m)
}

function formatTime(ts: number) {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// statusLabel / statusColor 来自 composables/useTaskLabels（Nuxt 自动导入）。

async function deleteTask(id: number) {
  if (!(await confirm({ title: '删除这条测试记录？', danger: true }))) return
  try {
    await useDataSource().deleteTask(id)
    historyStore.invalidate()
    await reload(true)
    notify.success('已删除记录')
  } catch (err: any) {
    notify.error(err?.statusMessage || err?.message || '删除失败')
  }
}

const totalRuns = computed(() => stats.value.reduce((acc, r) => acc + r.total, 0))
const totalSucceeded = computed(() => stats.value.reduce((acc, r) => acc + r.succeeded, 0))
const overallRate = computed(() => totalRuns.value ? totalSucceeded.value / totalRuns.value : 0)

// 按平台聚合：同一平台下的各模型合并到一行平台，子行展示各模型(类型作为模型标签)，
// 平台行汇总该平台所有模型的数据，可折叠。
interface StatsGroup {
  key: string
  provider_name: string
  api_format: string
  rows: StatsRow[]
  total: number
  succeeded: number
  failed: number
  success_rate: number
  avg_latency_ms: number | null
  last_run_at: number | null
}
const groupedStats = computed<StatsGroup[]>(() => {
  const map = new Map<string, StatsGroup>()
  for (const r of stats.value) {
    const key = `${r.provider_id ?? r.provider_name}`
    let g = map.get(key)
    if (!g) {
      g = {
        key,
        provider_name: r.provider_name,
        api_format: r.api_format,
        rows: [],
        total: 0,
        succeeded: 0,
        failed: 0,
        success_rate: 0,
        avg_latency_ms: null,
        last_run_at: null,
      }
      map.set(key, g)
    }
    g.rows.push(r)
    g.total += r.total
    g.succeeded += r.succeeded
    g.failed += r.failed
    if (r.last_run_at && (!g.last_run_at || r.last_run_at > g.last_run_at)) g.last_run_at = r.last_run_at
  }
  const groups = [...map.values()]
  for (const g of groups) {
    g.success_rate = g.total ? g.succeeded / g.total : 0
    // 加权平均耗时（按成功数加权，忽略无耗时的行）
    let wSum = 0, w = 0
    for (const r of g.rows) {
      if (r.avg_latency_ms != null && r.succeeded > 0) { wSum += r.avg_latency_ms * r.succeeded; w += r.succeeded }
    }
    g.avg_latency_ms = w ? Math.round(wSum / w) : null
    g.rows.sort((a, b) => (b.last_run_at ?? 0) - (a.last_run_at ?? 0))
  }
  return groups.sort((a, b) => (b.last_run_at ?? 0) - (a.last_run_at ?? 0))
})

// 折叠态：默认全部展开；记录被折叠的平台 key。
const collapsedGroups = ref<Set<string>>(new Set())
function toggleGroup(key: string) {
  const next = new Set(collapsedGroups.value)
  next.has(key) ? next.delete(key) : next.add(key)
  collapsedGroups.value = next
}

// ── 数据对比：同一个模型在不同平台上的 成本 / 速度 / 成功率 对比 + 10 分制评分 ──
// 评分标准（每项 10 分制，越高越好）：
//   成本  = 10 × 最低均价 / 本平台均价     （最便宜得 10）
//   速度  = 10 × 最短均耗时 / 本平台均耗时 （最快得 10）
//   成功率 = 成功率 × 10
//   综合  = 成本×0.4 + 速度×0.3 + 成功率×0.3
interface CompareCell {
  provider_id: number | null
  provider_name: string
  count: number          // 成功任务数（用于均值）
  total: number          // 总任务数
  avg_cost: number | null
  avg_latency_ms: number | null
  success_rate: number
  score_cost: number
  score_speed: number
  score_success: number
  score: number          // 综合
  best: boolean          // 综合最高
}
interface CompareModel {
  model_name: string
  kind: ModelKind
  cells: CompareCell[]
}
const comparisons = computed<CompareModel[]>(() => {
  // 按 模型名 → 平台 聚合成功任务的成本与耗时。
  const byModel = new Map<string, Map<string, {
    provider_id: number | null
    provider_name: string
    kind: string
    total: number
    okCount: number
    costSum: number
    costN: number
    latSum: number
    latN: number
  }>>()
  for (const t of tasks.value) {
    const mName = t.model_name
    if (!mName) continue
    let provs = byModel.get(mName)
    if (!provs) { provs = new Map(); byModel.set(mName, provs) }
    const pKey = `${t.provider_id ?? t.provider_name}`
    let cell = provs.get(pKey)
    if (!cell) {
      cell = { provider_id: t.provider_id, provider_name: t.provider_name, kind: t.kind, total: 0, okCount: 0, costSum: 0, costN: 0, latSum: 0, latN: 0 }
      provs.set(pKey, cell)
    }
    cell.total++
    if (t.status === 'succeeded') {
      cell.okCount++
      const c = costOf(t)
      if (c) { cell.costSum += c.cny; cell.costN++ }
      if (t.latency_ms != null) { cell.latSum += t.latency_ms; cell.latN++ }
    }
  }

  const out: CompareModel[] = []
  for (const [model_name, provs] of byModel) {
    // 只对比跨 ≥2 个平台的模型
    if (provs.size < 2) continue
    const raw = [...provs.values()].map((c) => ({
      provider_id: c.provider_id,
      provider_name: c.provider_name,
      kind: c.kind,
      count: c.okCount,
      total: c.total,
      avg_cost: c.costN ? c.costSum / c.costN : null,
      avg_latency_ms: c.latN ? c.latSum / c.latN : null,
      success_rate: c.total ? c.okCount / c.total : 0,
    }))
    const costs = raw.map((r) => r.avg_cost).filter((v): v is number => v != null && v > 0)
    const lats = raw.map((r) => r.avg_latency_ms).filter((v): v is number => v != null && v > 0)
    const minCost = costs.length ? Math.min(...costs) : null
    const minLat = lats.length ? Math.min(...lats) : null
    const cells: CompareCell[] = raw.map((r) => {
      const score_cost = r.avg_cost && minCost ? 10 * (minCost / r.avg_cost) : (r.avg_cost == null && minCost == null ? 10 : 0)
      const score_speed = r.avg_latency_ms && minLat ? 10 * (minLat / r.avg_latency_ms) : (r.avg_latency_ms == null && minLat == null ? 10 : 0)
      const score_success = r.success_rate * 10
      const score = score_cost * 0.4 + score_speed * 0.3 + score_success * 0.3
      return { ...r, score_cost, score_speed, score_success, score, best: false }
    })
    const top = Math.max(...cells.map((c) => c.score))
    cells.forEach((c) => { c.best = c.score === top && top > 0 })
    cells.sort((a, b) => b.score - a.score)
    const first = raw[0]
    if (first) out.push({ model_name, kind: first.kind as ModelKind, cells })
  }
  return out.sort((a, b) => a.model_name.localeCompare(b.model_name))
})

function scoreColor(s: number): string {
  if (s >= 8) return 'text-green-600'
  if (s >= 5) return 'text-[var(--c-fg-2)]'
  return 'text-amber-600'
}
</script>

<template>
  <div class="scroll-area h-full overflow-y-auto">
    <div class="mx-auto flex max-w-6xl flex-col gap-6 py-2">
      <!-- 顶部聚合数据 -->
      <div class="grid gap-3 sm:grid-cols-3">
        <div class="surface px-5 py-4">
          <div class="label-uppercase">总测试</div>
          <div class="mt-2 text-[32px] font-semibold tabular-nums text-[var(--c-fg)]">{{ totalRuns }}</div>
        </div>
        <div class="surface px-5 py-4">
          <div class="label-uppercase">成功率</div>
          <div class="mt-2 text-[32px] font-semibold tabular-nums text-primary-500">
            {{ (overallRate * 100).toFixed(1) }}%
          </div>
        </div>
        <div class="surface px-5 py-4">
          <div class="label-uppercase">已配置平台</div>
          <div class="mt-2 text-[32px] font-semibold tabular-nums text-[var(--c-fg)]">{{ providers.length }}</div>
        </div>
      </div>

      <!-- 各平台聚合 -->
      <div class="surface">
        <div class="border-b border-[var(--c-border)] px-5 py-3">
          <h3 class="text-[14px] font-semibold text-[var(--c-fg)]">各平台统计</h3>
        </div>
        <SkeletonRows v-if="loading && !stats.length" :rows="3" />
        <div v-else-if="!stats.length" class="px-5 py-8 text-center text-[13px] text-[var(--c-fg-4)]">暂无记录</div>
        <table v-else class="w-full text-left text-[13px]">
          <thead class="border-b border-[var(--c-border)] text-[12px] text-[var(--c-fg-4)]">
            <tr>
              <th class="px-4 py-2.5 font-medium">平台</th>
              <th class="px-4 py-2.5 font-medium">模型</th>
              <th class="px-4 py-2.5 text-right font-medium">总数</th>
              <th class="px-4 py-2.5 text-right font-medium">成功</th>
              <th class="px-4 py-2.5 text-right font-medium">失败</th>
              <th class="px-4 py-2.5 text-right font-medium">成功率</th>
              <th class="px-4 py-2.5 text-right font-medium">平均耗时</th>
              <th class="px-4 py-2.5 font-medium">最近运行</th>
            </tr>
          </thead>
          <tbody v-for="g in groupedStats" :key="g.key" class="border-b border-[var(--c-border)] last:border-0">
            <!-- 平台汇总行：点击折叠/展开该平台下的各类型子行 -->
            <tr
              class="cursor-pointer bg-[var(--c-surface-2)] hover:bg-[var(--c-surface-3)]"
              @click="toggleGroup(g.key)"
            >
              <td class="px-4 py-2.5">
                <div class="flex items-center gap-1.5">
                  <UIcon
                    name="i-carbon-chevron-right"
                    class="h-3.5 w-3.5 text-[var(--c-fg-4)] transition-transform"
                    :class="collapsedGroups.has(g.key) ? '' : 'rotate-90'"
                  />
                  <div>
                    <div class="font-medium text-[var(--c-fg)]">{{ g.provider_name }}</div>
                    <div class="font-mono text-[11px] text-[var(--c-fg-4)]">{{ g.api_format }}</div>
                  </div>
                </div>
              </td>
              <td class="px-4 py-2.5 text-[12px] text-[var(--c-fg-4)]">{{ g.rows.length }} 个模型</td>
              <td class="px-4 py-2.5 text-right font-mono font-medium tabular-nums">{{ g.total }}</td>
              <td class="px-4 py-2.5 text-right font-mono tabular-nums text-green-600">{{ g.succeeded }}</td>
              <td class="px-4 py-2.5 text-right font-mono tabular-nums text-[var(--c-fg-4)]">{{ g.failed }}</td>
              <td class="px-4 py-2.5 text-right font-mono tabular-nums" :class="g.success_rate >= 0.9 ? 'text-green-600' : 'text-[var(--c-fg-2)]'">
                {{ (g.success_rate * 100).toFixed(1) }}%
              </td>
              <td class="px-4 py-2.5 text-right font-mono tabular-nums">{{ formatLatency(g.avg_latency_ms) }}</td>
              <td class="px-4 py-2.5 font-mono text-[11px] text-[var(--c-fg-4)]">{{ g.last_run_at ? formatTime(g.last_run_at) : '—' }}</td>
            </tr>
            <!-- 各模型子行 -->
            <tr
              v-for="(row, i) in (collapsedGroups.has(g.key) ? [] : g.rows)"
              :key="i"
              class="border-t border-[var(--c-border-2)] hover:bg-[var(--c-surface-2)]"
            >
              <td class="px-4 py-2"></td>
              <td class="px-4 py-2">
                <div class="flex items-center gap-1.5">
                  <span class="font-mono text-[12px] text-[var(--c-fg-2)]">{{ row.model_name }}</span>
                  <KindBadge :kind="row.kind" />
                </div>
              </td>
              <td class="px-4 py-2 text-right font-mono tabular-nums">{{ row.total }}</td>
              <td class="px-4 py-2 text-right font-mono tabular-nums text-green-600">{{ row.succeeded }}</td>
              <td class="px-4 py-2 text-right font-mono tabular-nums text-[var(--c-fg-4)]">{{ row.failed }}</td>
              <td class="px-4 py-2 text-right font-mono tabular-nums" :class="row.success_rate >= 0.9 ? 'text-green-600' : 'text-[var(--c-fg-2)]'">
                {{ (row.success_rate * 100).toFixed(1) }}%
              </td>
              <td class="px-4 py-2 text-right font-mono tabular-nums">{{ formatLatency(row.avg_latency_ms) }}</td>
              <td class="px-4 py-2 font-mono text-[11px] text-[var(--c-fg-4)]">{{ row.last_run_at ? formatTime(row.last_run_at) : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 数据对比：同模型跨平台 成本/速度/成功率 + 10 分制评分 -->
      <div v-if="comparisons.length" class="surface">
        <div class="flex items-center justify-between border-b border-[var(--c-border)] px-5 py-3">
          <h3 class="text-[14px] font-semibold text-[var(--c-fg)]">数据对比</h3>
          <span class="text-[11px] text-[var(--c-fg-4)]">同模型跨平台 · 综合 = 成本×0.4 + 速度×0.3 + 成功率×0.3（10 分制）</span>
        </div>
        <div class="divide-y divide-[var(--c-border-2)]">
          <div v-for="cm in comparisons" :key="cm.model_name" class="px-5 py-4">
            <div class="mb-2 flex items-center gap-2">
              <KindBadge :kind="cm.kind" />
              <span class="font-mono text-[13px] font-medium text-[var(--c-fg)]">{{ cm.model_name }}</span>
              <span class="text-[11px] text-[var(--c-fg-4)]">{{ cm.cells.length }} 个平台</span>
            </div>
            <table class="w-full text-left text-[13px]">
              <thead class="text-[11px] text-[var(--c-fg-4)]">
                <tr>
                  <th class="py-1.5 pr-3 font-medium">平台</th>
                  <th class="py-1.5 px-3 text-right font-medium">均成本</th>
                  <th class="py-1.5 px-3 text-right font-medium">均耗时</th>
                  <th class="py-1.5 px-3 text-right font-medium">成功率</th>
                  <th class="py-1.5 px-3 text-right font-medium" title="10 × 最低均价 / 本平台均价">成本分</th>
                  <th class="py-1.5 px-3 text-right font-medium" title="10 × 最短均耗时 / 本平台均耗时">速度分</th>
                  <th class="py-1.5 px-3 text-right font-medium" title="成功率 × 10">成功率分</th>
                  <th class="py-1.5 pl-3 text-right font-medium">综合</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in cm.cells" :key="`${c.provider_id}`" class="border-t border-[var(--c-border-2)]">
                  <td class="py-2 pr-3">
                    <span class="text-[var(--c-fg)]">{{ c.provider_name }}</span>
                    <span v-if="c.best" class="ml-1.5 rounded-[2px] bg-primary-100 px-1.5 py-0.5 text-[10px] font-medium text-primary-700">推荐</span>
                  </td>
                  <td class="py-2 px-3 text-right font-mono tabular-nums">{{ c.avg_cost != null ? formatCost(c.avg_cost) : '—' }}</td>
                  <td class="py-2 px-3 text-right font-mono tabular-nums">{{ formatLatency(c.avg_latency_ms) }}</td>
                  <td class="py-2 px-3 text-right font-mono tabular-nums">{{ (c.success_rate * 100).toFixed(0) }}%</td>
                  <td class="py-2 px-3 text-right font-mono tabular-nums text-[var(--c-fg-4)]">{{ c.score_cost.toFixed(1) }}</td>
                  <td class="py-2 px-3 text-right font-mono tabular-nums text-[var(--c-fg-4)]">{{ c.score_speed.toFixed(1) }}</td>
                  <td class="py-2 px-3 text-right font-mono tabular-nums text-[var(--c-fg-4)]">{{ c.score_success.toFixed(1) }}</td>
                  <td class="py-2 pl-3 text-right font-mono font-semibold tabular-nums" :class="scoreColor(c.score)">{{ c.score.toFixed(1) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 历史明细 -->
      <div class="surface">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--c-border)] px-5 py-3">
          <h3 class="text-[14px] font-semibold text-[var(--c-fg)]">明细</h3>
          <div class="flex flex-wrap items-center gap-2">
            <div class="flex items-center gap-1">
              <button
                type="button"
                class="rounded-[4px] border px-2.5 py-1 text-[12px] transition"
                :class="filterProvider === null
                  ? 'border-primary-500 bg-primary-50 text-primary-700'
                  : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
                @click="filterProvider = null"
              >全部平台</button>
              <button
                v-for="p in providers"
                :key="p.id"
                type="button"
                class="rounded-[4px] border px-2.5 py-1 text-[12px] transition"
                :class="filterProvider === p.id
                  ? 'border-primary-500 bg-primary-50 text-primary-700'
                  : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
                @click="filterProvider = p.id"
              >{{ p.name }}</button>
            </div>
            <div class="flex items-center gap-1">
              <button
                v-for="opt in KIND_OPTIONS"
                :key="opt.label"
                type="button"
                class="rounded-[4px] border px-2.5 py-1 text-[12px] transition"
                :class="filterKind === opt.value
                  ? 'border-primary-500 bg-primary-50 text-primary-700'
                  : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
                @click="filterKind = opt.value as any"
              >{{ opt.label }}</button>
            </div>
            <div class="flex items-center gap-1">
              <button
                v-for="opt in STATUS_OPTIONS"
                :key="opt.label"
                type="button"
                class="rounded-[4px] border px-2.5 py-1 text-[12px] transition"
                :class="filterStatus === opt.value
                  ? 'border-primary-500 bg-primary-50 text-primary-700'
                  : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
                @click="filterStatus = opt.value as any"
              >{{ opt.label }}</button>
            </div>
            <UButton size="xs" variant="outline" color="neutral" icon="i-carbon-renew" :loading="loading"
              aria-label="刷新历史记录" title="刷新历史记录" @click="reload(true)" />
          </div>
        </div>
        <SkeletonRows v-if="loading && !tasks.length" :rows="8" />
        <div v-else-if="!tasks.length" class="px-5 py-8 text-center text-[13px] text-[var(--c-fg-4)]">没有命中的记录</div>
        <div v-else class="scroll-area max-h-[60vh] overflow-y-auto">
          <table class="w-full text-left text-[13px]">
            <thead class="sticky top-0 border-b border-[var(--c-border)] bg-[var(--c-surface)] text-[12px] text-[var(--c-fg-4)]">
              <tr>
                <th class="px-4 py-2.5 font-medium">状态</th>
                <th class="px-4 py-2.5 font-medium">平台 / 模型</th>
                <th class="px-4 py-2.5 font-medium">提示词</th>
                <th class="px-4 py-2.5 text-right font-medium">耗时</th>
                <th class="px-4 py-2.5 text-right font-medium">成本</th>
                <th class="px-4 py-2.5 font-medium">时间</th>
                <th class="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in tasks" :key="t.id" class="border-b border-[var(--c-border-2)] hover:bg-[var(--c-surface-2)]">
                <td class="px-4 py-2.5">
                  <UBadge :color="taskStatusColor(t)" variant="subtle">{{ taskStatusLabel(t) }}</UBadge>
                  <div
                    v-if="assetRetentionInfo(t).state === 'active' || assetRetentionInfo(t).state === 'due'"
                    class="mt-1 max-w-[180px] text-[10px] leading-snug"
                    :class="assetRetentionInfo(t).state === 'due' ? 'text-amber-600' : 'text-[var(--c-fg-6)]'"
                  >
                    {{ assetRetentionInfo(t).label }}<span v-if="assetRetentionInfo(t).state === 'active'">，请及时下载</span>
                  </div>
                  <div v-if="t.http_status" class="mt-0.5 font-mono text-[10px] text-[var(--c-fg-4)]">HTTP {{ t.http_status }}</div>
                </td>
                <td class="min-w-[180px] px-4 py-2.5">
                  <div class="flex items-center gap-1.5">
                    <KindBadge :kind="t.kind" :label="false" />
                    <span class="text-[var(--c-fg)]">{{ t.provider_name }}</span>
                  </div>
                  <div class="mt-0.5 truncate font-mono text-[11px] text-[var(--c-fg-4)]">{{ t.model_name }}</div>
                </td>
                <td class="max-w-[260px] px-4 py-2.5">
                  <div class="truncate text-[var(--c-fg-2)]" :title="t.prompt">{{ t.prompt }}</div>
                  <div v-if="t.error_message" class="mt-0.5 truncate font-mono text-[11px] text-red-600" :title="t.error_message">{{ t.error_message }}</div>
                </td>
                <td class="px-4 py-2.5 text-right font-mono tabular-nums">{{ formatLatency(t.latency_ms) }}</td>
                <td class="px-4 py-2.5 text-right font-mono text-[12px] tabular-nums">
                  <span v-if="costOf(t)" class="group/c relative inline-flex items-center gap-1 text-amber-600">
                    {{ formatCost(costOf(t)!.cny) }}
                    <UIcon name="i-carbon-help" class="h-3 w-3 cursor-help opacity-70" />
                    <span class="pointer-events-none absolute right-0 top-full z-30 mt-1 hidden w-max max-w-[280px] whitespace-normal rounded-[6px] border border-[var(--c-border)] bg-[var(--c-surface)] px-2.5 py-1.5 text-left text-[11px] font-normal leading-relaxed text-[var(--c-fg-3)] shadow-wf group-hover/c:block">
                      {{ costOf(t)!.formula }}
                    </span>
                  </span>
                  <span v-else class="text-[var(--c-fg-6)]">—</span>
                </td>
                <td class="px-4 py-2.5 font-mono text-[11px] text-[var(--c-fg-4)]">{{ formatTime(t.created_at) }}</td>
                <td class="px-4 py-2.5 text-right">
                  <div class="flex items-center justify-end gap-3">
                    <button type="button" class="link-action" @click="openDetail(t.id)">查看</button>
                    <button type="button" class="link-danger" @click="deleteTask(t.id)">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 查看任务详情 — reuses ResultViewer + TaskDetail from the console so the
         UX matches: 预览 / 概览 / 请求 / 响应 tabs all available. -->
    <UModal v-model:open="detailOpen" :close="false" :ui="{ content: 'sm:max-w-5xl' }">
      <template #content>
        <div class="surface flex h-[80vh] flex-col">
        <div v-if="detailTask" class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--c-border)] px-5 py-3">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge :color="taskStatusColor(detailTask)" :variant="detailTask.status === 'succeeded' ? 'subtle' : 'soft'">
              {{ taskStatusLabel(detailTask) }}
            </UBadge>
            <KindBadge :kind="detailTask.kind" />
            <span class="text-[14px] text-[var(--c-fg)]">{{ detailTask.provider_name }}</span>
            <span class="text-[var(--c-fg-7)]">/</span>
            <span class="font-mono text-[12px] text-[var(--c-fg-4)]">{{ detailTask.model_name }}</span>
          </div>
          <div class="flex items-center gap-3 text-[12px] text-[var(--c-fg-4)]">
            <span class="font-mono font-medium text-[var(--c-fg)] tabular-nums">{{ formatLatency(detailTask.latency_ms) }}</span>
            <span v-if="costOf(detailTask)" class="group/c relative inline-flex items-center gap-1 font-mono text-amber-600">
              {{ formatCost(costOf(detailTask)!.cny) }}
              <UIcon name="i-carbon-help" class="h-3 w-3 cursor-help opacity-70" />
              <span class="pointer-events-none absolute right-0 top-full z-30 mt-1 hidden w-max max-w-[280px] whitespace-normal rounded-[6px] border border-[var(--c-border)] bg-[var(--c-surface)] px-2.5 py-1.5 text-left text-[11px] font-normal leading-relaxed text-[var(--c-fg-3)] shadow-wf group-hover/c:block">
                {{ costOf(detailTask)!.formula }}
              </span>
            </span>
            <span v-if="detailTask.http_status" class="font-mono">HTTP {{ detailTask.http_status }}</span>
            <UButton size="xs" variant="ghost" color="neutral" icon="i-carbon-close"
              aria-label="关闭任务详情" title="关闭任务详情" @click="closeDetail" />
          </div>
        </div>
        <div v-if="detailTask" class="flex border-b border-[var(--c-border)] bg-[var(--c-surface)]">
          <button
            v-for="t in detailTabItems"
            :key="t.slot"
            type="button"
            class="px-5 py-2.5 text-[13px] font-medium transition border-b-2 -mb-px"
            :class="detailTab === t.slot
              ? 'text-primary-500 border-primary-500'
              : 'text-[var(--c-fg-4)] border-transparent hover:text-[var(--c-fg)]'"
            @click="detailTab = t.slot as DetailTab"
          >{{ t.label }}</button>
        </div>
        <div class="flex min-h-0 flex-1 flex-col">
          <div v-if="detailLoading" class="flex h-full items-center justify-center text-[13px] text-[var(--c-fg-4)]">
            <UIcon name="i-carbon-renew" class="mr-2 h-4 w-4 animate-spin" />加载中…
          </div>
          <template v-else-if="detailTask">
            <ResultViewer v-if="detailTab === 'preview'" :task="detailTask" />
            <TaskDetail v-else :task="detailTask" :mode="detailTab" :key="`${detailTask.id}-${detailTab}`" />
          </template>
        </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
