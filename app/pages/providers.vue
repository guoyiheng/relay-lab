<script setup lang="ts">
// 平台 + 模型管理页：增删改平台与其下模型，含配置导入/导出。
// 关闭 modal 走脏检查（未保存二次确认）；改动后强刷 providers store 传播到其他页。
import type { Provider, Model, ApiFormat, PriceMode } from '~~/types/api'
import { useProvidersStore } from '~/stores/providers'

interface ProviderWithModels extends Provider {
  models: Model[]
}

const providersStore = useProvidersStore()
const notify = useNotify()
const confirm = useConfirm()

// 排序偏好（#5）：默认按名称，可选创建时间，规则存 localStorage 跨刷新保持。
const LS_KEY_SORT = 'relay:providers:sort'
type SortMode = 'name' | 'created'
const sortMode = ref<SortMode>('name')
onMounted(() => {
  const v = localStorage.getItem(LS_KEY_SORT)
  if (v === 'name' || v === 'created') sortMode.value = v
})
watch(sortMode, (v) => localStorage.setItem(LS_KEY_SORT, v))
const providers = computed(() =>
  (sortMode.value === 'created' ? providersStore.byCreated : providersStore.byName) as ProviderWithModels[])
const loading = computed(() => providersStore.loading)
const error = ref<string | null>(null)
const importing = ref(false)
const exporting = ref(false)
const savingProvider = ref(false)
const savingModel = ref(false)
const importInputRef = ref<HTMLInputElement | null>(null)

type ProtocolFormat = Exclude<ApiFormat, 'full-url'>
type ProviderUrlMode = 'base' | 'full'

const FORMAT_OPTIONS: {
  value: ProtocolFormat
  label: string
  paths: { label: string; suffix: string }[]
}[] = [
  {
    value: 'openai-sync',
    label: 'OpenAI 兼容 · 同步',
    paths: [
      { label: '文本', suffix: '/chat/completions' },
      { label: '图片', suffix: '/images/generations' },
      { label: '视频', suffix: '/videos/generations' },
    ],
  },
  {
    value: 'openai-async',
    label: 'OpenAI 兼容 · 异步',
    paths: [
      { label: '图片提交', suffix: '/images/generations?async=true' },
      { label: '图片轮询', suffix: '/images/tasks/{task_id}' },
      { label: '视频提交', suffix: '/videos/generations?async=true' },
      { label: '视频轮询', suffix: '/videos/tasks/{task_id}' },
    ],
  },
  {
    value: 'xai-image',
    label: 'xAI Imagine · 图片',
    paths: [
      { label: '文生图', suffix: '/images/generations' },
      { label: '参考图编辑', suffix: '/images/edits' },
    ],
  },
  {
    value: 'doubao-video',
    label: 'Seedance官方 · 异步',
    paths: [
      { label: '提交', suffix: '/contents/generations/tasks' },
      { label: '轮询', suffix: '/contents/generations/tasks/{task_id}' },
    ],
  },
]

const KIND_OPTIONS = [
  { value: 'image', label: '图像' },
  { value: 'video', label: '视频' },
  { value: 'text', label: '文本' },
]

// 正在编辑的模型所属平台的协议（用于判断是否 Seedance）。
const editingProviderFormat = computed<ApiFormat | null>(() => {
  const pid = modelForm.value.provider_id
  if (pid == null) return null
  return (providers.value.find((p) => p.id === pid)?.api_format as ApiFormat) ?? null
})
// 仅 Seedance 的「视频」模型用含/不含视频两档计价；其余(含 Seedance 的非视频模型)都用提示/补全。
const isSeedanceVideoModel = computed(
  () => editingProviderFormat.value === 'doubao-video' && modelForm.value.kind === 'video',
)
// 计价方式选项：Seedance 视频的「按量」=分视频两档(per_mtoken_video)，其他=提示/补全(per_mtoken)。
const priceModeOptions = computed(() => {
  const tokenOpt = isSeedanceVideoModel.value
    ? { value: 'per_mtoken_video', label: '按量（¥/M tokens）' }
    : { value: 'per_mtoken', label: '按量（¥/M tokens）' }
  return [
    { value: '', label: '不计价' },
    { value: 'per_call', label: '按次（¥/次）' },
    tokenOpt,
  ]
})

const providerForm = ref<{
  id: number | null
  name: string
  base_url: string
  url_mode: ProviderUrlMode
  api_key: string
  api_format: ProtocolFormat
  enabled: boolean
  notes: string
  ark_access_key: string
  ark_secret_key: string
  ark_region: string
  ark_project_name: string
}>({
  id: null,
  name: '',
  base_url: '',
  url_mode: 'base',
  api_key: '',
  api_format: 'openai-sync',
  enabled: true,
  notes: '',
  ark_access_key: '',
  ark_secret_key: '',
  ark_region: '',
  ark_project_name: '',
})
const showProviderModal = ref(false)
const selectedFormatOption = computed(() => FORMAT_OPTIONS.find((opt) => opt.value === providerForm.value.api_format))

function endpointPreview(suffix: string) {
  const base = providerForm.value.base_url.trim()
  if (!base) return suffix
  return `${base.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`
}

const modelForm = ref<{
  id: number | null
  provider_id: number | null
  model_id: string
  display_name: string
  kind: 'image' | 'video' | 'text'
  default_params: string
  enabled: boolean
  price_mode: '' | PriceMode
  price_cny: string
  price_in_cny: string
  price_out_cny: string
  price_novideo_cny: string
  price_video_cny: string
  polish_model: boolean
  keys: { name: string; key: string; enabled: boolean }[]
}>({
  id: null,
  provider_id: null,
  model_id: '',
  display_name: '',
  kind: 'image',
  default_params: '',
  enabled: true,
  price_mode: '',
  price_cny: '',
  price_in_cny: '',
  price_out_cny: '',
  price_novideo_cny: '',
  price_video_cny: '',
  polish_model: false,
  keys: [],
})
const showModelModal = ref(false)
const modelError = ref<string | null>(null)
// 平台密钥/模型独立 key 的显示-隐藏开关
const showProviderKey = ref(false)
const showArkSecret = ref(false)
const showModelKey = ref<Record<number, boolean>>({})

// 弹窗脏检查：打开时记快照，关闭时比对。有未保存修改时不弹 confirm 拦截，
// 而是在弹窗底部显示红色提示；再次触发关闭(再点一次/再按一次 ESC)才真正关闭。
const providerSnapshot = ref('')
const modelSnapshot = ref('')
const providerCloseWarn = ref(false)
const modelCloseWarn = ref(false)
function snapProvider() { providerSnapshot.value = JSON.stringify(providerForm.value); providerCloseWarn.value = false }
function snapModel() { modelSnapshot.value = JSON.stringify(modelForm.value); modelCloseWarn.value = false }
function tryCloseProvider() {
  const dirty = JSON.stringify(providerForm.value) !== providerSnapshot.value
  if (dirty && !providerCloseWarn.value) { providerCloseWarn.value = true; return }
  showProviderModal.value = false
}
function tryCloseModel() {
  const dirty = JSON.stringify(modelForm.value) !== modelSnapshot.value
  if (dirty && !modelCloseWarn.value) { modelCloseWarn.value = true; return }
  showModelModal.value = false
}
// UModal 的 v-model：拦截 backdrop/ESC 关闭也走脏检查。
const providerModalOpen = computed({
  get: () => showProviderModal.value,
  set: (v: boolean) => { if (v) showProviderModal.value = true; else tryCloseProvider() },
})
const modelModalOpen = computed({
  get: () => showModelModal.value,
  set: (v: boolean) => { if (v) showModelModal.value = true; else tryCloseModel() },
})
// 用户继续编辑则清除「未保存」红色提示，下次关闭重新提示。
watch(providerForm, () => { providerCloseWarn.value = false }, { deep: true })
watch(modelForm, () => { modelCloseWarn.value = false }, { deep: true })

// Mutations (create/edit/delete provider or model) force-refresh the shared
// store so the console page picks up the change on next navigation.
async function loadProviders() {
  error.value = null
  try {
    await providersStore.loadAll(true)
  } catch (err: any) {
    error.value = err?.statusMessage || err?.message || '加载失败'
  }
}

onMounted(() => providersStore.loadAll())

function openCreateProvider() {
  providerForm.value = {
    id: null,
    name: '',
    base_url: '',
    url_mode: 'base',
    api_key: '',
    api_format: 'openai-sync',
    enabled: true,
    notes: '',
    ark_access_key: '',
    ark_secret_key: '',
    ark_region: '',
    ark_project_name: '',
  }
  showProviderKey.value = false
  snapProvider()
  showProviderModal.value = true
}

function openEditProvider(p: ProviderWithModels) {
  providerForm.value = {
    id: p.id,
    name: p.name,
    base_url: p.base_url,
    url_mode: p.api_format === 'full-url' ? 'full' : 'base',
    api_key: p.api_key || '',
    api_format: p.api_format === 'full-url' ? 'openai-sync' : p.api_format,
    enabled: p.enabled,
    notes: p.notes || '',
    ark_access_key: p.ark_access_key || '',
    ark_secret_key: p.ark_secret_key || '',
    ark_region: p.ark_region || '',
    ark_project_name: p.ark_project_name || '',
  }
  showProviderKey.value = false
  snapProvider()
  showProviderModal.value = true
}

async function submitProvider() {
  const form = providerForm.value
  const apiFormat: ApiFormat = form.url_mode === 'full' ? 'full-url' : form.api_format
  const body: Record<string, unknown> = {
    name: form.name,
    base_url: form.base_url,
    api_format: apiFormat,
    enabled: form.enabled,
    notes: form.notes || null,
  }
  if (form.api_key.trim()) body.api_key = form.api_key.trim()
  if (!form.id && !form.api_key.trim()) {
    notify.error('新平台必须提供 API Key')
    return
  }
  // Seedance 素材库凭证：仅 doubao-video 平台提交（空值 → 后端清空为 NULL）。
  if (apiFormat === 'doubao-video') {
    body.ark_access_key = form.ark_access_key.trim() || null
    body.ark_secret_key = form.ark_secret_key.trim() || null
    body.ark_region = form.ark_region.trim() || null
    body.ark_project_name = form.ark_project_name.trim() || null
  }
  savingProvider.value = true
  try {
    if (form.id) {
      await useDataSource().updateProvider(form.id, body as any)
    } else {
      await useDataSource().createProvider(body as any)
    }
    showProviderModal.value = false
    await loadProviders()
    notify.success(form.id ? '已保存' : '已创建平台')
  } catch (err: any) {
    notify.error(err?.statusMessage || err?.message || '保存失败')
  } finally {
    savingProvider.value = false
  }
}

const copyingId = ref<number | null>(null)
// 复制前用 Popover 二次确认：记录待确认的平台 id（同一时刻只开一个）。
const copyConfirmId = ref<number | null>(null)
function closeCopyConfirm() { copyConfirmId.value = null }
// 点「确认复制」：关掉 Popover 再执行复制。
function confirmCopyProvider(p: ProviderWithModels) {
  copyConfirmId.value = null
  void copyProvider(p)
}
// 复制平台（含其下模型与配置）到新平台「原名-copy」，除名称外全部沿用。
async function copyProvider(p: ProviderWithModels) {
  if (copyingId.value != null) return
  copyingId.value = p.id
  try {
    const res = await useDataSource().copyProvider(p.id)
    await loadProviders()
    notify.success(`已复制为「${res.provider.name}」`, `含 ${res.models} 个模型`)
  } catch (err: any) {
    notify.error(err?.statusMessage || err?.message || '复制失败')
  } finally {
    copyingId.value = null
  }
}

async function deleteProvider(p: ProviderWithModels) {
  if (!(await confirm({ title: `删除「${p.name}」？`, description: '此操作会同时删除其下所有模型。', danger: true }))) return
  try {
    await useDataSource().deleteProvider(p.id)
    await loadProviders()
    notify.success('已删除平台')
  } catch (err: any) {
    notify.error(err?.statusMessage || err?.message || '删除失败')
  }
}

// Delete from inside the edit dialog (bottom-left button), then close it.
async function deleteProviderFromModal() {
  if (!providerForm.value.id) return
  if (!(await confirm({ title: `删除「${providerForm.value.name}」？`, description: '此操作会同时删除其下所有模型。', danger: true }))) return
  try {
    await useDataSource().deleteProvider(providerForm.value.id)
    showProviderModal.value = false
    await loadProviders()
    notify.success('已删除平台')
  } catch (err: any) {
    notify.error(err?.statusMessage || err?.message || '删除失败')
  }
}

function openCreateModel(p: ProviderWithModels) {
  modelForm.value = {
    id: null,
    provider_id: p.id,
    model_id: '',
    display_name: '',
    kind: p.api_format === 'doubao-video' ? 'video' : 'image',
    default_params: '',
    enabled: true,
    price_mode: '',
    price_cny: '',
    price_in_cny: '',
    price_out_cny: '',
    price_novideo_cny: '',
    price_video_cny: '',
    polish_model: false,
    keys: [],
  }
  modelError.value = null
  snapModel()
  showModelModal.value = true
}

function openEditModel(m: Model) {
  modelForm.value = {
    id: m.id,
    provider_id: m.provider_id,
    model_id: m.model_id,
    display_name: m.display_name || '',
    kind: m.kind,
    default_params: m.default_params ? JSON.stringify(m.default_params, null, 2) : '',
    enabled: m.enabled,
    price_mode: (m.price_mode || '') as ('' | PriceMode),
    price_cny: m.price_cny != null ? String(m.price_cny) : '',
    price_in_cny: m.price_in_cny != null ? String(m.price_in_cny) : '',
    price_out_cny: m.price_out_cny != null ? String(m.price_out_cny) : '',
    price_novideo_cny: m.price_novideo_cny != null ? String(m.price_novideo_cny) : '',
    price_video_cny: m.price_video_cny != null ? String(m.price_video_cny) : '',
    polish_model: !!m.polish_model,
    keys: (m.keys || []).map((k) => ({ name: k.name || '', key: k.key, enabled: k.enabled !== false })),
  }
  modelError.value = null
  snapModel()
  showModelModal.value = true
}

function addModelKey() {
  modelForm.value.keys.push({ name: '', key: '', enabled: true })
}
function removeModelKey(i: number) {
  modelForm.value.keys.splice(i, 1)
}

async function submitModel() {
  modelError.value = null
  const form = modelForm.value
  let parsed: Record<string, unknown> | null = null
  const txt = form.default_params.trim()
  if (txt) {
    try {
      const v = JSON.parse(txt)
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        modelError.value = 'default_params 必须是对象 (JSON)'
        return
      }
      parsed = v as Record<string, unknown>
    } catch (err: any) {
      modelError.value = `JSON 解析失败: ${err?.message || ''}`
      return
    }
  }
  const body: Record<string, unknown> = {
    model_id: form.model_id,
    display_name: form.display_name || null,
    kind: form.kind,
    default_params: parsed,
    enabled: form.enabled,
    price_mode: form.price_mode || null,
    polish_model: form.polish_model,
    keys: form.keys.filter((k) => k.key.trim()).map((k) => ({ name: k.name.trim() || undefined, key: k.key.trim(), enabled: k.enabled })),
  }
  const toNum = (s: string) => (String(s ?? '').trim() !== '' ? Number(s) : null)
  if (form.price_mode === 'per_call') {
    body.price_cny = toNum(form.price_cny)
  } else if (form.price_mode === 'per_mtoken') {
    body.price_in_cny = toNum(form.price_in_cny)
    body.price_out_cny = toNum(form.price_out_cny)
    body.price_cny = toNum(form.price_cny)
  } else if (form.price_mode === 'per_mtoken_video') {
    body.price_novideo_cny = toNum(form.price_novideo_cny)
    body.price_video_cny = toNum(form.price_video_cny)
  }
  savingModel.value = true
  const isEdit = !!form.id
  try {
    if (form.id) {
      await useDataSource().updateModel(form.id, body as any)
    } else {
      await useDataSource().createModel({ ...body, provider_id: form.provider_id } as any)
    }
    showModelModal.value = false
    await loadProviders()
    notify.success(isEdit ? '已保存模型' : '已创建模型')
  } catch (err: any) {
    modelError.value = err?.statusMessage || err?.message || '保存失败'
  } finally {
    savingModel.value = false
  }
}

async function deleteModel(m: Model) {
  if (!(await confirm({ title: `删除模型「${m.display_name || m.model_id}」？`, danger: true }))) return
  try {
    await useDataSource().deleteModel(m.id)
    await loadProviders()
    notify.success('已删除模型')
  } catch (err: any) {
    notify.error(err?.statusMessage || err?.message || '删除失败')
  }
}

// Delete from inside the edit dialog (bottom-left button), then close it.
async function deleteModelFromModal() {
  if (!modelForm.value.id) return
  if (!(await confirm({ title: `删除模型「${modelForm.value.display_name || modelForm.value.model_id}」？`, danger: true }))) return
  try {
    await useDataSource().deleteModel(modelForm.value.id)
    showModelModal.value = false
    await loadProviders()
    notify.success('已删除模型')
  } catch (err: any) {
    notify.error(err?.statusMessage || err?.message || '删除失败')
  }
}

async function toggleModel(m: Model) {
  try {
    await useDataSource().updateModel(m.id, { enabled: !m.enabled })
    await loadProviders()
  } catch { /* ignore */ }
}

function formatLabel(f: string) {
  if (f === 'openai-sync') return 'OPENAI · 同步'
  if (f === 'openai-async') return 'OPENAI · 异步'
  if (f === 'xai-image') return 'xAI IMAGINE · 图片'
  if (f === 'doubao-video') return 'SEEDANCE官方 · 异步'
  if (f === 'full-url') return '完整 URL · 直连'
  return f
}

function priceLabel(m: Model): string | null {
  if (m.price_mode === 'per_call' && m.price_cny != null) {
    const v = m.price_cny.toFixed(m.price_cny < 1 ? 4 : 2).replace(/\.?0+$/, '')
    return `¥${v}/次`
  }
  if (m.price_mode === 'per_mtoken') {
    const fmt = (n: number) => n.toFixed(n < 1 ? 4 : 2).replace(/\.?0+$/, '')
    if (m.price_in_cny != null || m.price_out_cny != null) {
      const inp = m.price_in_cny != null ? `入¥${fmt(m.price_in_cny)}` : ''
      const out = m.price_out_cny != null ? `出¥${fmt(m.price_out_cny)}` : ''
      return [inp, out].filter(Boolean).join(' · ') + '/M'
    }
    if (m.price_cny != null) return `¥${fmt(m.price_cny)}/M tokens`
  }
  if (m.price_mode === 'per_mtoken_video') {
    const fmt = (n: number) => n.toFixed(n < 1 ? 4 : 2).replace(/\.?0+$/, '')
    if (m.price_novideo_cny != null || m.price_video_cny != null) {
      const nv = m.price_novideo_cny != null ? `无视频¥${fmt(m.price_novideo_cny)}` : ''
      const wv = m.price_video_cny != null ? `含视频¥${fmt(m.price_video_cny)}` : ''
      return [nv, wv].filter(Boolean).join(' · ') + '/M'
    }
  }
  return null
}

async function exportConfig() {
  exporting.value = true
  try {
    const data = await useDataSource().exportProviders()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `relay-lab-config-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    notify.success('已导出配置')
  } catch (err: any) {
    notify.error(err?.statusMessage || err?.message || '导出失败')
  } finally {
    exporting.value = false
  }
}

async function importConfig() {
  if (!importInputRef.value) return
  const file = importInputRef.value.files?.[0]
  if (!file) return

  importing.value = true
  try {
    const text = await file.text()
    const data = JSON.parse(text)
    const result = await useDataSource().importProviders(data)
    await loadProviders()
    if (result.errors.length) {
      notify.error(`导入完成，${result.errors.length} 条出错`, `${result.providers} 个平台，${result.models} 个模型`)
    } else {
      notify.success('导入完成', `${result.providers} 个平台，${result.models} 个模型`)
    }
  } catch (err: any) {
    notify.error(err?.statusMessage || err?.message || '导入失败')
  } finally {
    importing.value = false
    if (importInputRef.value) importInputRef.value.value = ''
  }
}
</script>

<template>
  <div class="scroll-area h-full overflow-y-auto">
    <div class="mx-auto flex max-w-5xl flex-col gap-6 py-2">
      <div class="flex items-end justify-between gap-3">
        <p class="text-[14px] text-[var(--c-fg-4)]">配置中转 API 接入点和模型</p>
        <div class="flex items-center gap-2">
          <div class="seg-toggle" role="group" aria-label="排序方式">
            <button type="button" class="seg-btn" :class="{ 'seg-btn-active': sortMode === 'name' }"
              title="按平台名称排序" @click="sortMode = 'name'">名称</button>
            <button type="button" class="seg-btn" :class="{ 'seg-btn-active': sortMode === 'created' }"
              title="按创建时间排序（新的在前）" @click="sortMode = 'created'">创建时间</button>
          </div>
          <input ref="importInputRef" type="file" accept=".json" class="hidden" @change="importConfig">
          <!-- hover「新建平台」按钮时，导入/导出以 Popover 形式在下方展开（带文字）。 -->
          <UPopover mode="hover" :content="{ align: 'end', side: 'bottom', sideOffset: 8 }"
            :ui="{ content: 'p-1.5 flex flex-col gap-1' }">
            <UButton color="primary" icon="i-carbon-add" @click="openCreateProvider">新建平台</UButton>
            <template #content>
              <UButton color="neutral" variant="ghost" icon="i-carbon-download" :loading="exporting"
                class="justify-start" block @click="exportConfig">导出配置</UButton>
              <UButton color="neutral" variant="ghost" icon="i-carbon-upload" :loading="importing"
                class="justify-start" block @click="() => importInputRef?.click()">导入配置</UButton>
            </template>
          </UPopover>
        </div>
      </div>

      <UAlert v-if="error" :title="error" color="error" variant="soft" />

      <div v-if="loading && !providers.length" class="surface">
        <SkeletonRows :rows="4" />
      </div>
      <div v-else-if="!providers.length"
        class="surface flex flex-col items-center justify-center gap-2 py-16 text-center">
        <UIcon name="i-carbon-flash" class="h-8 w-8 text-[var(--c-fg-7)]" />
        <div class="text-[14px] text-[var(--c-fg-2)]">暂无平台</div>
      </div>

      <div v-for="p in providers" :key="p.id" class="surface">
        <div class="flex flex-wrap items-center gap-3 border-b border-[var(--c-border)] px-5 py-4">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-[16px] font-semibold text-[var(--c-fg)]">{{ p.name }}</span>
              <UBadge color="primary" variant="subtle">{{ formatLabel(p.api_format)
              }}</UBadge>
              <UBadge v-if="!p.enabled" color="neutral" variant="subtle">已停用</UBadge>
              <UBadge color="neutral" variant="outline">{{ p.models.length }} 模型
              </UBadge>
            </div>
            <div class="mt-1 truncate font-mono text-[12px] text-[var(--c-fg-4)]">{{ p.base_url }}</div>
          </div>
          <div class="flex flex-shrink-0 items-center gap-3">
            <UPopover
              :open="copyConfirmId === p.id"
              :ui="{ content: 'w-64 p-3' }"
              @update:open="(v: boolean) => { copyConfirmId = v ? p.id : null }">
              <button type="button" class="link-action" :disabled="copyingId === p.id"
                @click="copyConfirmId = p.id">{{ copyingId === p.id ? '复制中' : '复制' }}</button>
              <template #content>
                <div class="space-y-3">
                  <div class="flex items-start gap-2">
                    <UIcon name="i-carbon-copy" class="mt-0.5 h-4 w-4 flex-shrink-0 text-primary-600" />
                    <p class="text-[13px] leading-relaxed text-[var(--c-fg-2)]">
                      复制「{{ p.name }}」为新平台，含其下 {{ p.models.length }} 个模型与全部配置？
                    </p>
                  </div>
                  <div class="flex justify-end gap-2">
                    <UButton size="xs" variant="outline" color="neutral" @click="closeCopyConfirm">取消</UButton>
                    <UButton size="xs" color="primary" @click="confirmCopyProvider(p)">确认复制</UButton>
                  </div>
                </div>
              </template>
            </UPopover>
            <button type="button" class="link-action" @click="openEditProvider(p)">编辑</button>
          </div>
        </div>

        <div class="px-5 py-4">
          <div class="mb-3 flex items-center justify-between">
            <h4 class="label-uppercase">模型</h4>
            <UButton size="xs" color="primary" variant="outline" icon="i-carbon-add"
              @click="openCreateModel(p)">新建模型</UButton>
          </div>
          <div v-if="!p.models.length"
            class="rounded-[4px] border border-dashed border-[var(--c-border)] px-4 py-6 text-center text-[13px] text-[var(--c-fg-4)]">
            暂无模型
          </div>
          <div v-else class="grid gap-2 sm:grid-cols-2">
            <div v-for="m in p.models" :key="m.id"
              class="flex items-center gap-2 rounded-[4px] border border-[var(--c-border-2)] px-3 py-2.5">
              <ModelIcon :model-id="m.model_id" :kind="m.kind" :size="24" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5 truncate">
                  <span class="truncate text-[14px] font-medium text-[var(--c-fg)]">
                    {{ m.display_name || m.model_id }}
                  </span>
                  <span v-if="m.polish_model"
                    class="flex-shrink-0 rounded-[2px] bg-primary-100 px-1.5 py-0.5 text-[10px] font-medium text-primary-700">润色</span>
                </div>
                <div class="mt-0.5 flex flex-wrap items-center gap-2 truncate">
                  <span class="truncate font-mono text-[11px] text-[var(--c-fg-4)]">{{ m.model_id }}</span>
                  <!-- 功能标签（生图/生视频/文本）放价格左边 -->
                  <KindBadge :kind="m.kind" />
                  <span v-if="priceLabel(m)"
                    class="rounded-[2px] bg-primary-50 px-1.5 py-0.5 font-mono text-[10px] text-primary-700">
                    {{ priceLabel(m) }}
                  </span>
                </div>
              </div>
              <USwitch size="xs" :model-value="m.enabled" :aria-label="m.enabled ? '已启用，点击停用' : '已停用，点击启用'"
                @update:model-value="toggleModel(m)" />
              <button type="button" class="link-action" @click="openEditModel(m)">编辑</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 平台 modal -->
    <UModal v-model:open="providerModalOpen" :dismissible="false"
      :ui="{ content: 'sm:max-w-lg', header: 'px-5 py-4', body: 'p-5', footer: 'px-5 py-4' }"
      @close:prevent="tryCloseProvider">
      <template #header>
        <h3 class="h-sub">{{ providerForm.id ? '编辑平台' : '新建平台' }}</h3>
      </template>
      <template #body>
        <div class="space-y-4">
          <p v-if="providerCloseWarn" class="rounded-[4px] border border-red-200 bg-red-50 px-3 py-1.5 text-[12px] text-red-500">有未保存的修改，再次关闭将丢弃</p>
          <div>
            <div class="field-label required">名称</div>
            <UInput v-model="providerForm.name" placeholder="例如 Seedance 官方 / T8 Star"
              />
          </div>
          <div>
            <div class="mb-1.5 flex items-center justify-between gap-3">
              <div class="field-label required !mb-0">{{ providerForm.url_mode === 'full' ? '完整 URL' : 'Base URL' }}</div>
              <div class="seg-toggle" role="group" aria-label="平台 URL 类型">
                <button type="button" class="seg-btn" :class="{ 'seg-btn-active': providerForm.url_mode === 'base' }"
                  @click="providerForm.url_mode = 'base'">Base URL</button>
                <button type="button" class="seg-btn" :class="{ 'seg-btn-active': providerForm.url_mode === 'full' }"
                  @click="providerForm.url_mode = 'full'">完整 URL</button>
              </div>
            </div>
            <UInput v-model="providerForm.base_url"
              :placeholder="providerForm.url_mode === 'full' ? 'https://api.example.com/v1/images/generations' : 'https://api.example.com/v1'"
              class="font-mono" />
            <p class="field-hint">
              {{ providerForm.url_mode === 'full'
                ? '请求会直接 POST 到该地址，不再追加任何路径。'
                : '无需填写接口路径，系统会按下方协议自动拼接。' }}
            </p>
          </div>
          <div>
            <div class="field-label">API Key</div>
            <UInput v-model="providerForm.api_key" :type="showProviderKey ? 'text' : 'password'"
              :placeholder="providerForm.id ? '留空则不修改' : 'sk-xxxxxxxxxxxxxxxx'"
              class="font-mono">
              <template #trailing>
                <button type="button" class="text-[var(--c-fg-4)] transition hover:text-[var(--c-fg)]"
                  :aria-label="showProviderKey ? '隐藏密钥' : '显示密钥'" @click="showProviderKey = !showProviderKey">
                  <UIcon :name="showProviderKey ? 'i-carbon-view-off' : 'i-carbon-view'" class="h-4 w-4" />
                </button>
              </template>
            </UInput>
          </div>
          <div v-if="providerForm.url_mode === 'base'">
            <div class="field-label required">API 协议</div>
            <div class="grid grid-cols-1 gap-1.5">
              <button v-for="opt in FORMAT_OPTIONS" :key="opt.value" type="button"
                class="rounded-[4px] border px-3 py-2.5 text-left transition" :class="providerForm.api_format === opt.value
                  ? 'border-primary-500 bg-primary-50 text-primary-700'
                  : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
                @click="providerForm.api_format = opt.value">
                <span class="block text-[13px] font-medium">{{ opt.label }}</span>
                <span class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] leading-4 opacity-75">
                  <span v-for="path in opt.paths" :key="path.label">{{ path.label }} {{ path.suffix }}</span>
                </span>
              </button>
            </div>
            <div v-if="selectedFormatOption" class="mt-2.5 rounded-[4px] bg-[var(--c-surface-2)] px-3 py-2.5">
              <div class="mb-1.5 text-[11px] font-medium text-[var(--c-fg-3)]">最终请求地址</div>
              <div class="space-y-1">
                <div v-for="path in selectedFormatOption.paths" :key="path.label"
                  class="flex min-w-0 items-baseline gap-2 text-[11px]">
                  <span class="w-14 flex-shrink-0 text-[var(--c-fg-4)]">{{ path.label }}</span>
                  <span class="min-w-0 break-all font-mono text-[var(--c-fg-2)]">{{ endpointPreview(path.suffix) }}</span>
                </div>
              </div>
            </div>
          </div>
          <!-- Seedance 素材库（虚拟人像库）：仅视频协议展示，用于「参考走素材库」。留空则不启用。 -->
          <div v-if="providerForm.url_mode === 'base' && providerForm.api_format === 'doubao-video'"
            class="space-y-3 rounded-[6px] border border-[var(--c-border)] bg-[var(--c-surface)] p-3">
            <div class="text-[13px] font-medium text-[var(--c-fg-2)]">素材库（选填）</div>
            <div class="text-[12px] leading-relaxed text-[var(--c-fg-4)]">
              配置后创作时可勾选「参考走素材库」，参考素材先入库再引用，避免被拦截。
            </div>
            <div>
              <div class="field-label">Access Key</div>
              <UInput v-model="providerForm.ark_access_key" placeholder="AKLT..." class="font-mono" />
            </div>
            <div>
              <div class="field-label">Secret Key</div>
              <UInput v-model="providerForm.ark_secret_key" :type="showArkSecret ? 'text' : 'password'"
                placeholder="留空则不修改" class="font-mono">
                <template #trailing>
                  <button type="button" class="text-[var(--c-fg-4)] transition hover:text-[var(--c-fg)]"
                    :aria-label="showArkSecret ? '隐藏密钥' : '显示密钥'" @click="showArkSecret = !showArkSecret">
                    <UIcon :name="showArkSecret ? 'i-carbon-view-off' : 'i-carbon-view'" class="h-4 w-4" />
                  </button>
                </template>
              </UInput>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <div class="field-label">Region</div>
                <UInput v-model="providerForm.ark_region" placeholder="ap-southeast-1" class="font-mono" />
              </div>
              <div>
                <div class="field-label">Project</div>
                <UInput v-model="providerForm.ark_project_name" placeholder="default" class="font-mono" />
              </div>
            </div>
          </div>
          <div>
            <div class="field-label">备注</div>
            <UTextarea v-model="providerForm.notes" :rows="3" placeholder="可选" />
          </div>
          <label class="flex items-center justify-between rounded-[4px] border border-[var(--c-border)] px-3 py-2">
            <span class="text-[14px] text-[var(--c-fg-2)]">启用此平台</span>
            <USwitch v-model="providerForm.enabled" />
          </label>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <UButton v-if="providerForm.id" variant="ghost" color="error" icon="i-carbon-trash-can"
            @click="deleteProviderFromModal">删除平台</UButton>
          <span v-else />
          <div class="flex gap-2">
            <UButton variant="outline" color="neutral" :disabled="savingProvider"
              @click="tryCloseProvider">取消</UButton>
            <UButton color="primary" :loading="savingProvider" @click="submitProvider">{{ providerForm.id ?
              '保存' : '创建' }}</UButton>
          </div>
        </div>
      </template>
    </UModal>

    <!-- 模型 modal -->
    <UModal v-model:open="modelModalOpen" :dismissible="false"
      :ui="{ content: 'sm:max-w-lg', header: 'px-5 py-4', body: 'p-5', footer: 'px-5 py-4' }"
      @close:prevent="tryCloseModel">
      <template #header>
        <h3 class="h-sub">{{ modelForm.id ? '编辑模型' : '新建模型' }}</h3>
      </template>
      <template #body>
        <div class="space-y-4">
          <p v-if="modelCloseWarn" class="rounded-[4px] border border-red-200 bg-red-50 px-3 py-1.5 text-[12px] text-red-500">有未保存的修改，再次关闭将丢弃</p>
          <div>
            <div class="field-label required">模型 ID</div>
            <UInput v-model="modelForm.model_id" placeholder="gpt-image-2 / dall-e-3 / ep-xxx"
              class="font-mono" />
          </div>
          <div>
            <div class="field-label">显示名称</div>
            <UInput v-model="modelForm.display_name" placeholder="可选" />
          </div>
          <div>
            <div class="field-label required">类型</div>
            <div class="flex gap-2">
              <button v-for="opt in KIND_OPTIONS" :key="opt.value" type="button"
                class="flex-1 rounded-[4px] border px-3 py-2 text-[13px] transition" :class="modelForm.kind === opt.value
                  ? 'border-primary-500 bg-primary-50 text-primary-700'
                  : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
                @click="modelForm.kind = opt.value as 'image' | 'video' | 'text'">{{ opt.label }}</button>
            </div>
          </div>
          <div>
            <div class="field-label">计价方式</div>
            <div class="flex flex-wrap gap-2">
              <button v-for="opt in priceModeOptions" :key="opt.value || 'none'" type="button"
                class="rounded-[4px] border px-3 py-2 text-[13px] transition" :class="modelForm.price_mode === opt.value
                  ? 'border-primary-500 bg-primary-50 text-primary-700'
                  : 'border-[var(--c-border)] bg-[var(--c-surface)] text-[var(--c-fg-3)] hover:border-[var(--c-fg-5)]'"
                @click="modelForm.price_mode = opt.value as ('' | PriceMode)">{{ opt.label }}</button>
            </div>
            <div v-if="modelForm.price_mode === 'per_call'" class="mt-3">
              <div class="field-label">价格 ¥ <span
                  class="ml-1 font-normal normal-case tracking-normal text-[var(--c-fg-4)]">每次</span></div>
              <UInput v-model="modelForm.price_cny" type="number" step="0.0001" min="0" placeholder="0.00"
                class="font-mono" />
            </div>
            <div v-else-if="modelForm.price_mode === 'per_mtoken'" class="mt-3 grid grid-cols-2 gap-3">
              <div>
                <div class="field-label">提示 ¥/M</div>
                <UInput v-model="modelForm.price_in_cny" type="number" step="0.0001" min="0" placeholder="0.00"
                  class="font-mono" />
              </div>
              <div>
                <div class="field-label">补全 ¥/M</div>
                <UInput v-model="modelForm.price_out_cny" type="number" step="0.0001" min="0" placeholder="0.00"
                  class="font-mono" />
              </div>
            </div>
            <div v-else-if="modelForm.price_mode === 'per_mtoken_video'" class="mt-3 grid grid-cols-2 gap-3">
              <div>
                <div class="field-label">输入不含视频 ¥/M</div>
                <UInput v-model="modelForm.price_novideo_cny" type="number" step="0.0001" min="0" placeholder="0.00"
                  class="font-mono" />
              </div>
              <div>
                <div class="field-label">输入包含视频 ¥/M</div>
                <UInput v-model="modelForm.price_video_cny" type="number" step="0.0001" min="0" placeholder="0.00"
                  class="font-mono" />
              </div>
            </div>
          </div>
          <!-- 润色开关：仅文本模型 -->
          <label v-if="modelForm.kind === 'text'"
            class="flex items-center justify-between rounded-[4px] border border-[var(--c-border)] px-3 py-2">
            <div>
              <span class="text-[14px] text-[var(--c-fg-2)]">用于润色</span>
              <p class="text-[12px] text-[var(--c-fg-5)]">开启后将作为润色模型（同时只能有一个）</p>
            </div>
            <USwitch v-model="modelForm.polish_model" />
          </label>
          <!-- 独立 key（设了就不用平台 key） -->
          <div>
            <div class="field-label flex items-center justify-between">
              <span>独立 Key <span class="font-normal normal-case tracking-normal text-[var(--c-fg-5)]">（留空则用平台
                  Key）</span></span>
              <button type="button" class="link-action" @click="addModelKey">+ 添加</button>
            </div>
            <div v-if="!modelForm.keys.length"
              class="rounded-[4px] border border-dashed border-[var(--c-border)] px-3 py-2 text-[12px] text-[var(--c-fg-5)]">
              未配置独立 key，使用平台 key</div>
            <div v-else class="space-y-2">
              <div v-for="(k, i) in modelForm.keys" :key="i" class="flex items-center gap-2">
                <USwitch v-model="k.enabled" size="xs" />
                <UInput v-model="k.name" placeholder="名称(选填)"
                  class="w-28 flex-shrink-0" />
                <UInput v-model="k.key" :type="showModelKey[i] ? 'text' : 'password'" placeholder="sk-..."
                  class="flex-1 font-mono">
                  <template #trailing>
                    <button type="button" class="text-[var(--c-fg-4)] transition hover:text-[var(--c-fg)]"
                      :aria-label="showModelKey[i] ? '隐藏' : '显示'" @click="showModelKey[i] = !showModelKey[i]">
                      <UIcon :name="showModelKey[i] ? 'i-carbon-view-off' : 'i-carbon-view'" class="h-4 w-4" />
                    </button>
                  </template>
                </UInput>
                <button type="button"
                  class="grid h-7 w-7 flex-shrink-0 place-items-center rounded-[4px] text-red-500 hover:bg-red-50"
                  @click="removeModelKey(i)">
                  <UIcon name="i-carbon-trash-can" class="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
          <div>
            <div class="field-label">默认参数 (JSON)</div>
            <UTextarea v-model="modelForm.default_params" :rows="4" placeholder='{ "size": "1024x1024", "n": 1 }'
              class="font-mono" />
            <p class="field-hint">运行测试时作为基础参数填入，可临时覆盖。</p>
          </div>
          <UAlert v-if="modelError" :title="modelError" color="error" variant="soft" />
          <label class="flex items-center justify-between rounded-[4px] border border-[var(--c-border)] px-3 py-2">
            <span class="text-[14px] text-[var(--c-fg-2)]">启用此模型</span>
            <USwitch v-model="modelForm.enabled" />
          </label>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <UButton v-if="modelForm.id" variant="ghost" color="error" icon="i-carbon-trash-can"
            @click="deleteModelFromModal">删除模型</UButton>
          <span v-else />
          <div class="flex gap-2">
            <UButton variant="outline" color="neutral" :disabled="savingModel"
              @click="tryCloseModel">取消</UButton>
            <UButton color="primary" :loading="savingModel" @click="submitModel">{{ modelForm.id ? '保存' :
              '创建' }}</UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
