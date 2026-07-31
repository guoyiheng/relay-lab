/**
 * OnlineDataSource —— DataSource 的在线实现。
 *
 * 薄包现有 /api/* 端点，逐个搬入原先散落在 stores/composables/页面里的 $fetch 调用，
 * 行为保持完全一致（同参数、同返回、同副作用），确保这一步「零回归」。离线实现
 * (OfflineDataSource) 后续单独落地，二者由 useDataSource() 工厂按模式切换。
 *
 * 注：埋点(analytics)、认证(auth)、成本表(/cost) 暂不纳入本接口——它们要么与模式无关
 * (auth 登录流后续单独处理)，要么离线无意义(analytics/cost)，各自保留原调用。
 */
import type {
  Provider,
  ProviderWithModels,
  ProviderInput,
  Model,
  ModelInput,
  TaskRow,
  TaskListQuery,
  TaskRunPayload,
  RefResolveItem,
  PickerAsset,
  ModelKind,
} from '~~/types/api'
import type { StatsRow } from '~/stores/history'
import type { DataSource } from './types'

export class OnlineDataSource implements DataSource {
  readonly mode = 'online' as const

  // ── 平台 Providers ──────────────────────────────────────────────
  listProviders() {
    return $fetch<ProviderWithModels[]>('/api/providers')
  }
  createProvider(input: ProviderInput) {
    return $fetch<Provider>('/api/providers', { method: 'POST', body: input })
  }
  updateProvider(id: number, patch: Partial<ProviderInput>) {
    return $fetch<Provider>(`/api/providers/${id}`, { method: 'PATCH', body: patch })
  }
  async deleteProvider(id: number) {
    await $fetch(`/api/providers/${id}`, { method: 'DELETE' })
  }
  copyProvider(id: number) {
    return $fetch<{ provider: { name: string }; models: number }>(`/api/providers/${id}/copy`, { method: 'POST' })
  }
  exportProviders() {
    return $fetch('/api/providers/export')
  }
  importProviders(data: unknown) {
    return $fetch<{ providers: number; models: number; errors: unknown[] }>('/api/providers/import', {
      method: 'POST',
      body: data as any,
    })
  }

  // ── 模型 Models ─────────────────────────────────────────────────
  createModel(input: ModelInput) {
    return $fetch<Model>('/api/models', { method: 'POST', body: input })
  }
  updateModel(id: number, patch: Partial<ModelInput>) {
    return $fetch<Model>(`/api/models/${id}`, { method: 'PATCH', body: patch })
  }
  async deleteModel(id: number) {
    await $fetch(`/api/models/${id}`, { method: 'DELETE' })
  }

  // ── 任务 Tasks ──────────────────────────────────────────────────
  listTasks(query: TaskListQuery = {}) {
    // 与原 /api/tasks query 对齐：ids 批量拉取优先，否则按过滤条件。
    const q: Record<string, string> = {}
    if (query.ids?.length) {
      q.ids = query.ids.join(',')
      q.limit = String(query.ids.length)
    } else {
      if (query.limit != null) q.limit = String(query.limit)
      if (query.provider_id) q.provider_id = String(query.provider_id)
      if (query.kind) q.kind = query.kind
      if (query.status) q.status = query.status
    }
    return $fetch<TaskRow[]>('/api/tasks', { query: q })
  }
  getTask(id: number) {
    return $fetch<TaskRow>(`/api/tasks/${id}`)
  }
  runTask(payload: TaskRunPayload) {
    return $fetch<TaskRow>('/api/tasks/run', { method: 'POST', body: payload })
  }
  async deleteTask(id: number) {
    await $fetch(`/api/tasks/${id}`, { method: 'DELETE' })
  }
  async setFavorite(id: number, favorite: boolean) {
    await $fetch(`/api/tasks/${id}/favorite`, { method: 'POST', body: { favorite } })
  }
  analyzeTask(id: number, type: 'structured' | 'sensitive') {
    return $fetch<{ analysis: unknown }>(`/api/tasks/${id}/analyze`, { method: 'POST', body: { type } })
  }
  taskCurl(id: number) {
    return $fetch<{ curl: string }>(`/api/tasks/${id}/curl`)
  }
  taskStats() {
    return $fetch<StatsRow[]>('/api/tasks/stats')
  }

  // ── 素材 Assets ─────────────────────────────────────────────────
  listAssets(kind?: ModelKind) {
    return $fetch<PickerAsset[]>('/api/assets', { query: kind ? { kind } : {} })
  }
  // 「先上传拿 id 再跑任务」，服务端 sha256 去重。搬自 composables/useRefUpload.ts。
  async resolveRefIds(items: RefResolveItem[]) {
    const ids: string[] = []
    for (const it of items) {
      if (it.id) { ids.push(it.id); continue }
      if (it.file) {
        const fd = new FormData()
        fd.append('file', it.file)
        fd.append('kind', it.kind)
        const res = await $fetch<{ id: string }>('/api/uploads', { method: 'POST', body: fd })
        ids.push(res.id)
      } else if (it.public_url) {
        const res = await $fetch<{ id: string }>('/api/uploads/import', {
          method: 'POST',
          body: { url: it.public_url, kind: it.kind },
        })
        ids.push(res.id)
      } else {
        throw new Error('参考素材缺少可上传的文件或链接')
      }
    }
    return ids
  }
  async deleteAsset(id: string) {
    await $fetch(`/api/uploads/${id}`, { method: 'DELETE' })
  }
  async deleteTaskResult(taskId: number, idx: number) {
    await $fetch(`/api/tasks/${taskId}/result/${idx}`, { method: 'DELETE' })
  }

  // ── 提示词辅助 Prompt ────────────────────────────────────────────
  polishPrompt(input: { prompt: string; kind: ModelKind; customCommand?: string }) {
    return $fetch<{ polished?: string }>('/api/prompt/polish', { method: 'POST', body: input })
  }
}
