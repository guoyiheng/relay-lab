<script setup lang="ts">
// 成本表：另一平台的计价/积分参考数据，本项目仅维护。仅 xxn 用户可访问。
const me = useCurrentUser()
const notify = useNotify()
const confirm = useConfirm()
onMounted(async () => {
  if (!me.value) await fetchCurrentUser()
  if (me.value?.username !== 'xxn') navigateTo('/')
})

interface CostEntry {
  id: number
  category: string
  kind: 'image' | 'video'
  model: string
  provider: string | null
  price_mode: 'per_call' | 'per_mtoken' | 'per_second' | null
  resolution: string | null
  duration_s: number | null
  cost_cny: number
  points: number | null
  note: string | null
  sort: number
}

const entries = ref<CostEntry[]>([])
const loading = ref(false)
async function reload() {
  loading.value = true
  try { entries.value = await $fetch<CostEntry[]>('/api/cost') }
  catch { entries.value = [] }
  finally { loading.value = false }
}
onMounted(reload)

// 筛选
const filterProvider = ref<string | null>(null)
const filterMode = ref<string | null>(null)
const providerOptions = computed(() => Array.from(new Set(entries.value.map((e) => e.provider).filter(Boolean))) as string[])
function matchFilter(e: CostEntry): boolean {
  return (!filterProvider.value || e.provider === filterProvider.value)
    && (!filterMode.value || e.price_mode === filterMode.value)
}

// 三层分组：模式(category) → 平台(provider) → 模型(model) → 各档行。
interface ModelGroup { key: string; model: string; rows: CostEntry[] }
interface ProviderGroup { key: string; provider: string; models: ModelGroup[] }
interface CategoryGroup { key: string; category: string; isVideo: boolean; providers: ProviderGroup[]; total: number }
const categoryGroups = computed<CategoryGroup[]>(() => {
  const cats = new Map<string, CategoryGroup>()
  for (const e of entries.value) {
    if (!matchFilter(e)) continue
    let cat = cats.get(e.category)
    if (!cat) { cat = { key: e.category, category: e.category, isVideo: e.kind === 'video', providers: [], total: 0 }; cats.set(e.category, cat) }
    if (e.kind === 'video') cat.isVideo = true
    cat.total++
    const pk = e.provider || '—'
    let prov = cat.providers.find((p) => p.provider === pk)
    if (!prov) { prov = { key: `${e.category}__${pk}`, provider: pk, models: [] }; cat.providers.push(prov) }
    let mod = prov.models.find((m) => m.model === e.model)
    if (!mod) { mod = { key: `${prov.key}__${e.model}`, model: e.model, rows: [] }; prov.models.push(mod) }
    mod.rows.push(e)
  }
  return [...cats.values()]
})

// 智能添加
const smartText = ref('')
const smartLoading = ref(false)
const smartError = ref<string | null>(null)
async function smartAdd() {
  const text = smartText.value.trim()
  if (!text) return
  smartLoading.value = true
  smartError.value = null
  try {
    const parsed = await $fetch('/api/cost/parse', { method: 'POST', body: { text } })
    await $fetch('/api/cost', { method: 'POST', body: parsed })
    smartText.value = ''
    await reload()
  } catch (err: any) {
    smartError.value = err?.data?.statusMessage || err?.statusMessage || err?.message || '添加失败'
  } finally {
    smartLoading.value = false
  }
}

async function removeEntry(e: CostEntry) {
  if (!(await confirm({ title: `删除「${e.model}${e.resolution ? ' · ' + e.resolution : ''}」这条数据？`, danger: true }))) return
  try {
    await $fetch(`/api/cost/${e.id}`, { method: 'DELETE' })
    await reload()
    notify.success('已删除')
  } catch (err: any) {
    notify.error(err?.data?.statusMessage || err?.statusMessage || '删除失败')
  }
}

// 行内编辑保存：points 空字符串视为 null（回到自动估算）。
async function saveEntry(id: number, patch: Partial<CostEntry>) {
  const body: Record<string, unknown> = { ...patch }
  if (patch.points === undefined || (patch.points as any) === '' || patch.points === null) body.points = null
  try {
    await $fetch(`/api/cost/${id}`, { method: 'PATCH', body })
    await reload()
  } catch (err: any) {
    notify.error(err?.data?.statusMessage || err?.statusMessage || '保存失败')
  }
}
</script>
<!-- TEMPLATE_PLACEHOLDER -->
<template>
  <div class="scroll-area h-full overflow-y-auto">
    <div class="mx-auto flex max-w-5xl flex-col gap-5 py-2">
      <p class="text-[14px] text-[var(--c-fg-4)]">另一平台的计价 / 积分参考数据，仅在本项目维护展示。</p>

      <!-- 智能添加 + 筛选 -->
      <div class="surface p-4">
        <div class="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-[var(--c-fg)]">
          <UIcon name="i-carbon-magic-wand" class="h-4 w-4 text-primary-600" /> 智能添加
        </div>
        <div class="flex gap-2">
          <UInput v-model="smartText" placeholder="用自然语言描述一条数据，如：T8 的 veo3.1 参考生视频，1080P 8秒，成本 0.9 元"
            class="flex-1" :disabled="smartLoading"
            @keydown.enter="smartAdd" />
          <UButton color="primary" :loading="smartLoading" @click="smartAdd">解析添加</UButton>
        </div>
        <p v-if="smartError" class="mt-1.5 text-[12px] text-red-500">{{ smartError }}</p>
        <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--c-border-2)] pt-3">
          <span class="text-[12px] text-[var(--c-fg-4)]">筛选</span>
          <select v-model="filterProvider"
            class="h-7 rounded-[4px] border border-[var(--c-border)] bg-[var(--c-surface)] px-2 text-[12px] text-[var(--c-fg-3)] outline-none focus:border-primary-400">
            <option :value="null">全部供应商</option>
            <option v-for="p in providerOptions" :key="p" :value="p">{{ p }}</option>
          </select>
          <select v-model="filterMode"
            class="h-7 rounded-[4px] border border-[var(--c-border)] bg-[var(--c-surface)] px-2 text-[12px] text-[var(--c-fg-3)] outline-none focus:border-primary-400">
            <option :value="null">全部定价模式</option>
            <option value="per_call">按次</option>
            <option value="per_mtoken">按量</option>
            <option value="per_second">按秒</option>
          </select>
        </div>
      </div>

      <!-- 模式 → 平台 → 模型 三层分组 -->
      <div v-if="loading && !entries.length" class="surface px-5 py-8 text-center text-[13px] text-[var(--c-fg-4)]">加载中…</div>
      <div v-else-if="!categoryGroups.length" class="surface px-5 py-8 text-center text-[13px] text-[var(--c-fg-4)]">暂无数据</div>
      <CostSection v-for="cat in categoryGroups" :key="cat.key" :group="cat" @delete="removeEntry" @save="saveEntry" />
    </div>
  </div>
</template>
