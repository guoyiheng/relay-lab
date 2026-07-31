/**
 * OfflineDataSource —— DataSource 的离线实现（配置/任务/素材全存浏览器 IndexedDB）。
 *
 * 与在线的对应：D1 表 → IndexedDB object store；R2 字节 → 素材记录里的 base64 data URL。
 * 复刻在线的业务规则（平台名唯一、润色模型互斥、价格按 mode 分档、keys 规范化、sha256
 * 去重），确保离线/在线行为一致。上游调用相关的方法（runTask/analyze/polish/curl）依赖
 * /api/proxy，在步骤3-4接入前先抛「待接入」错误。
 */
import type {
  Provider, ProviderWithModels, ProviderInput,
  Model, ModelInput, ModelKind, PriceMode,
  TaskRow, TaskListQuery, TaskRunPayload,
  RefResolveItem, PickerAsset,
} from '~~/types/api'
import type { StatsRow } from '~/stores/history'
import { shellSingleQuote, taskEndpoint } from '~~/shared/task-curl'
import type { DataSource } from './types'
import { idb } from './idb'
import { runOfflineTask, resumeOfflineTaskPolls, hydrateOfflineTask, type OfflineTaskRecord } from './offline-task'

function now() { return Date.now() }
function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '*'.repeat(key.length)
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

// 价格按计价模式归一：只保留该模式相关档位，其余置 null（对齐 server/api/models）。
function normalizePrice(input: {
  price_mode?: PriceMode | null
  price_cny?: number | null; price_in_cny?: number | null; price_out_cny?: number | null
  price_novideo_cny?: number | null; price_video_cny?: number | null
}) {
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined || (v as any) === '') return null
    const n = Number(v)
    if (Number.isNaN(n) || n < 0) throw new Error('价格必须是非负数')
    return n
  }
  const mode = input.price_mode || null
  const out = {
    price_mode: mode,
    price_cny: null as number | null, price_in_cny: null as number | null, price_out_cny: null as number | null,
    price_novideo_cny: null as number | null, price_video_cny: null as number | null,
  }
  if (mode === 'per_mtoken') {
    out.price_in_cny = num(input.price_in_cny); out.price_out_cny = num(input.price_out_cny); out.price_cny = num(input.price_cny)
  } else if (mode === 'per_mtoken_video') {
    out.price_novideo_cny = num(input.price_novideo_cny); out.price_video_cny = num(input.price_video_cny)
  } else if (mode === 'per_call') {
    out.price_cny = num(input.price_cny)
  }
  return out
}

// keys 规范化：{name?,key,enabled}[]，过滤空 key，无有效项返回 null。
function normalizeKeys(input: unknown): Model['keys'] {
  if (!Array.isArray(input)) return null
  const arr = input
    .map((k: any) => ({
      name: typeof k?.name === 'string' ? k.name.trim() : undefined,
      key: typeof k?.key === 'string' ? k.key.trim() : '',
      enabled: k?.enabled !== false,
    }))
    .filter((k) => k.key)
  return arr.length ? arr : null
}

export class OfflineDataSource implements DataSource {
  readonly mode = 'offline' as const

  // ── 平台 Providers ──────────────────────────────────────────────
  async listProviders(): Promise<ProviderWithModels[]> {
    const providers = await idb.getAll<Provider>('providers')
    providers.sort((a, b) => b.created_at - a.created_at)  // 与在线 ORDER BY created_at DESC 一致
    const models = await idb.getAll<Model>('models')
    return providers.map((p) => ({
      ...p,
      api_key_masked: maskKey(p.api_key),
      models: models
        .filter((m) => m.provider_id === p.id)
        .map((m) => ({ ...m, provider_name: p.name }))
        .sort((a, b) => a.id - b.id),
    }))
  }

  private async assertNameFree(name: string, exceptId?: number) {
    const all = await idb.getAll<Provider>('providers')
    if (all.some((p) => p.name === name && p.id !== exceptId)) {
      throw new Error('平台名称已存在，请换一个')
    }
  }

  async createProvider(input: ProviderInput): Promise<Provider> {
    const name = (input.name || '').trim()
    const base_url = (input.base_url || '').trim().replace(/\/+$/, '')
    const api_key = (input.api_key || '').trim()
    if (!name) throw new Error('请填写平台名称')
    if (!base_url) throw new Error('请填写 Base URL')
    if (!api_key) throw new Error('请填写 API Key')
    await this.assertNameFree(name)
    const t = now()
    const rec: Omit<Provider, 'id'> = {
      name, base_url, api_key, api_key_masked: maskKey(api_key),
      api_format: input.api_format,
      enabled: input.enabled !== false,
      notes: input.notes ?? null,
      ark_access_key: input.ark_access_key ?? null,
      ark_secret_key: input.ark_secret_key ?? null,
      ark_region: input.ark_region ?? null,
      ark_project_name: input.ark_project_name ?? null,
      created_at: t, updated_at: t,
    }
    const id = Number(await idb.add('providers', rec))
    return { ...rec, id }
  }

  async updateProvider(id: number, patch: Partial<ProviderInput>): Promise<Provider> {
    const cur = await idb.get<Provider>('providers', id)
    if (!cur) throw new Error('平台不存在')
    if (patch.name !== undefined && patch.name.trim() !== cur.name) {
      await this.assertNameFree(patch.name.trim(), id)
    }
    const next: Provider = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.base_url !== undefined ? { base_url: patch.base_url.trim().replace(/\/+$/, '') } : {}),
      ...(patch.api_key !== undefined ? { api_key: patch.api_key.trim() } : {}),
      ...(patch.api_format !== undefined ? { api_format: patch.api_format } : {}),
      ...(patch.enabled !== undefined ? { enabled: !!patch.enabled } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes ?? null } : {}),
      ...(patch.ark_access_key !== undefined ? { ark_access_key: patch.ark_access_key ?? null } : {}),
      ...(patch.ark_secret_key !== undefined ? { ark_secret_key: patch.ark_secret_key ?? null } : {}),
      ...(patch.ark_region !== undefined ? { ark_region: patch.ark_region ?? null } : {}),
      ...(patch.ark_project_name !== undefined ? { ark_project_name: patch.ark_project_name ?? null } : {}),
      updated_at: now(),
    }
    next.api_key_masked = maskKey(next.api_key)
    await idb.put('providers', next)
    return next
  }

  async deleteProvider(id: number): Promise<void> {
    // 级联删其下模型（与在线一致：删平台同时删模型）。任务保留（有平台名快照）。
    const models = await idb.getAllByIndex<Model>('models', 'provider_id', id)
    await Promise.all(models.map((m) => idb.delete('models', m.id)))
    await idb.delete('providers', id)
  }

  async copyProvider(id: number): Promise<{ provider: { name: string }; models: number }> {
    const src = await idb.get<Provider>('providers', id)
    if (!src) throw new Error('平台不存在')
    // 生成不重复的「原名-copy」（已存在则追加序号）。
    const all = await idb.getAll<Provider>('providers')
    const taken = new Set(all.map((p) => p.name))
    let name = `${src.name}-copy`
    let i = 2
    while (taken.has(name)) { name = `${src.name}-copy${i++}` }
    // 复制平台（key 一并沿用，与在线 copy 一致——除名称外全同）。
    const created = await this.createProvider({
      name, base_url: src.base_url, api_key: src.api_key, api_format: src.api_format,
      enabled: src.enabled, notes: src.notes,
      ark_access_key: src.ark_access_key, ark_secret_key: src.ark_secret_key,
      ark_region: src.ark_region, ark_project_name: src.ark_project_name,
    })
    // 复制其下模型（新平台 id，模型 id 由 IndexedDB 重新分配）。
    const srcModels = await idb.getAllByIndex<Model>('models', 'provider_id', id)
    for (const m of srcModels) {
      await this.createModel({
        provider_id: created.id, model_id: m.model_id, display_name: m.display_name,
        kind: m.kind, default_params: m.default_params, enabled: m.enabled,
        price_mode: m.price_mode, price_cny: m.price_cny, price_in_cny: m.price_in_cny,
        price_out_cny: m.price_out_cny, price_novideo_cny: m.price_novideo_cny,
        price_video_cny: m.price_video_cny,
        polish_model: false,  // 避免复制触发润色互斥连锁；用户按需再开
        keys: m.keys,
      })
    }
    return { provider: { name }, models: srcModels.length }
  }

  async exportProviders(): Promise<unknown> {
    // 与在线 /api/providers/export 同形，包含完整明文凭证，作离线↔在线迁移通道。
    const providers = await idb.getAll<Provider>('providers')
    providers.sort((a, b) => b.created_at - a.created_at)
    const models = await idb.getAll<Model>('models')
    return {
      providers: providers.map((p) => ({
        name: p.name, base_url: p.base_url, api_key: p.api_key,
        api_format: p.api_format, enabled: p.enabled, notes: p.notes,
        ark_access_key: p.ark_access_key, ark_secret_key: p.ark_secret_key,
        ark_region: p.ark_region, ark_project_name: p.ark_project_name,
      })),
      models: models.map((m) => ({
        provider_name: providers.find((p) => p.id === m.provider_id)?.name,
        model_id: m.model_id, display_name: m.display_name, kind: m.kind,
        default_params: m.default_params, enabled: m.enabled,
        price_mode: m.price_mode, price_cny: m.price_cny, price_in_cny: m.price_in_cny,
        price_out_cny: m.price_out_cny, price_novideo_cny: m.price_novideo_cny, price_video_cny: m.price_video_cny,
        polish_model: m.polish_model, keys: m.keys || [],
      })),
      exported_at: new Date().toISOString(),
    }
  }

  async importProviders(data: unknown): Promise<{ providers: number; models: number; errors: unknown[] }> {
    const d = data as { providers?: any[]; models?: any[] }
    const errors: unknown[] = []
    let pCount = 0, mCount = 0
    const nameToId = new Map<string, number>()
    for (const p of d?.providers || []) {
      try {
        // 同名平台沿用现有配置；新平台恢复导出文件中的明文凭证。
        const existing = (await idb.getAll<Provider>('providers')).find((x) => x.name === p.name)
        if (existing) { nameToId.set(p.name, existing.id); continue }
        const created = await this.createProvider({
          name: p.name, base_url: p.base_url, api_key: p.api_key || '（导入后请填写）',
          api_format: p.api_format, enabled: p.enabled !== false, notes: p.notes ?? null,
          ark_access_key: p.ark_access_key ?? null, ark_secret_key: p.ark_secret_key ?? null,
          ark_region: p.ark_region ?? null, ark_project_name: p.ark_project_name ?? null,
        })
        nameToId.set(p.name, created.id); pCount++
      } catch (e: any) { errors.push({ provider: p?.name, error: e?.message }) }
    }
    for (const m of d?.models || []) {
      try {
        const pid = nameToId.get(m.provider_name)
        if (!pid) { errors.push({ model: m?.model_id, error: '找不到所属平台' }); continue }
        await this.createModel({ ...m, provider_id: pid })
        mCount++
      } catch (e: any) { errors.push({ model: m?.model_id, error: e?.message }) }
    }
    return { providers: pCount, models: mCount, errors }
  }

  // ── 模型 Models ─────────────────────────────────────────────────
  private async clearPolishExcept(id: number) {
    const all = await idb.getAll<Model>('models')
    await Promise.all(all.filter((m) => m.id !== id && m.polish_model)
      .map((m) => idb.put('models', { ...m, polish_model: false })))
  }

  async createModel(input: ModelInput): Promise<Model> {
    const provider = await idb.get<Provider>('providers', input.provider_id)
    if (!provider) throw new Error('平台不存在')
    const model_id = (input.model_id || '').trim()
    if (!model_id) throw new Error('请填写模型 ID')
    // 同平台下模型 id 唯一（对齐在线 UNIQUE 约束）。
    const siblings = await idb.getAllByIndex<Model>('models', 'provider_id', input.provider_id)
    if (siblings.some((m) => m.model_id === model_id)) throw new Error('该平台下已存在同名模型')
    const price = normalizePrice(input)
    const t = now()
    const rec: Omit<Model, 'id'> = {
      provider_id: input.provider_id, provider_name: provider.name,
      model_id, display_name: input.display_name ?? null, kind: input.kind,
      default_params: input.default_params ?? null,
      enabled: input.enabled !== false,
      ...price,
      polish_model: !!input.polish_model,
      keys: normalizeKeys(input.keys),
      created_at: t, updated_at: t,
    }
    const id = Number(await idb.add('models', rec))
    if (rec.polish_model) await this.clearPolishExcept(id)
    return { ...rec, id }
  }

  async updateModel(id: number, patch: Partial<ModelInput>): Promise<Model> {
    const cur = await idb.get<Model>('models', id)
    if (!cur) throw new Error('模型不存在')
    if (patch.model_id !== undefined) {
      const v = patch.model_id.trim()
      if (!v) throw new Error('模型 ID 不能为空')
      const siblings = await idb.getAllByIndex<Model>('models', 'provider_id', cur.provider_id)
      if (siblings.some((m) => m.id !== id && m.model_id === v)) throw new Error('该平台下已存在同名模型')
    }
    // 价格：任一价格字段或 price_mode 出现在 patch 里就整体重算。
    const priceTouched = ['price_mode', 'price_cny', 'price_in_cny', 'price_out_cny', 'price_novideo_cny', 'price_video_cny']
      .some((k) => k in patch)
    const price = priceTouched ? normalizePrice({ ...cur, ...patch }) : {}
    const next: Model = {
      ...cur,
      ...(patch.model_id !== undefined ? { model_id: patch.model_id.trim() } : {}),
      ...(patch.display_name !== undefined ? { display_name: patch.display_name ?? null } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.default_params !== undefined ? { default_params: patch.default_params ?? null } : {}),
      ...(patch.enabled !== undefined ? { enabled: !!patch.enabled } : {}),
      ...price,
      ...(patch.keys !== undefined ? { keys: normalizeKeys(patch.keys) } : {}),
      ...(patch.polish_model !== undefined ? { polish_model: !!patch.polish_model } : {}),
      updated_at: now(),
    }
    await idb.put('models', next)
    if (patch.polish_model) await this.clearPolishExcept(id)
    return next
  }

  async deleteModel(id: number): Promise<void> {
    await idb.delete('models', id)
  }

  // ── 任务 Tasks ──────────────────────────────────────────────────
  async listTasks(query: TaskListQuery = {}): Promise<TaskRow[]> {
    let rows = (await idb.getAll<TaskRow & { deleted_at?: number | null }>('tasks'))
      .filter((t) => !t.deleted_at)                    // 软删过滤（对齐在线）
    if (query.ids?.length) {
      const set = new Set(query.ids)
      rows = rows.filter((t) => set.has(t.id))
    } else {
      if (query.provider_id) rows = rows.filter((t) => t.provider_id === query.provider_id)
      if (query.kind) rows = rows.filter((t) => t.kind === query.kind)
      if (query.status) rows = rows.filter((t) => t.status === query.status)
    }
    rows.sort((a, b) => b.created_at - a.created_at)
    if (query.limit != null && !query.ids?.length) rows = rows.slice(0, query.limit)
    return rows
  }

  async getTask(id: number): Promise<TaskRow> {
    const t = await idb.get<OfflineTaskRecord>('tasks', id)
    if (!t || t.deleted_at) throw new Error('任务不存在')
    return hydrateOfflineTask(t)
  }

  runTask(payload: TaskRunPayload): Promise<TaskRow> {
    return runOfflineTask(payload)
  }

  // 刷新后重启浏览器侧轮询循环（在线由服务端驱动，无需此步）。
  resumeTaskPolls(tasks: TaskRow[]): void {
    void resumeOfflineTaskPolls(tasks)
  }

  async deleteTask(id: number): Promise<void> {
    // 软删（对齐在线）：置 deleted_at，list/get 过滤。
    const t = await idb.get<TaskRow & { deleted_at?: number | null }>('tasks', id)
    if (!t) return
    await idb.put('tasks', { ...t, deleted_at: now() })
  }

  async setFavorite(id: number, favorite: boolean): Promise<void> {
    const t = await idb.get<TaskRow>('tasks', id)
    if (!t) return
    await idb.put('tasks', { ...t, favorite })
  }

  // 分析同步跑完（离线无后台 job）：调 /api/proxy/llm 拿结果，合并进 task.analysis 落库、返回。
  // 不持久化中间 running 态——刷新丢失的仅是内存乐观态，避免 IDB 里留下永久 running。
  async analyzeTask(id: number, type: 'structured' | 'sensitive'): Promise<{ analysis: unknown }> {
    const task = await idb.get<TaskRow & { deleted_at?: number | null }>('tasks', id)
    if (!task || task.deleted_at) throw new Error('任务不存在')
    const prompt = (task.prompt || '').trim()
    if (!prompt) throw new Error('该任务无提示词')
    const creds = await this.resolveChatCreds()
    const kind: 'image' | 'video' = task.kind === 'video' ? 'video' : 'image'
    const { result } = await $fetch<{ result: any }>('/api/proxy/llm', {
      method: 'POST',
      body: { op: type, ...creds, prompt, kind },
    })
    const cur = (task.analysis && typeof task.analysis === 'object' ? task.analysis : {}) as Record<string, unknown>
    const merged = type === 'structured'
      ? { ...cur, structured: result.structured, highlights: result.highlights, segments: result.segments }
      : { ...cur, sensitive: result }
    await idb.put('tasks', { ...task, analysis: merged, updated_at: now() })
    return { analysis: merged }
  }

  async taskCurl(id: number): Promise<{ curl: string }> {
    const task = await idb.get<TaskRow & { deleted_at?: number | null }>('tasks', id)
    if (!task || task.deleted_at) throw new Error('任务不存在')
    const provider = task.provider_id ? await idb.get<Provider>('providers', task.provider_id) : null
    if (!provider) throw new Error('任务关联的平台已删除')
    const model = task.model_id ? await idb.get<Model>('models', task.model_id) : null
    const apiKey = model?.keys?.find((key) => key.enabled !== false && key.key)?.key || provider.api_key
    const endpoint = taskEndpoint(task, provider.base_url)
    if (!endpoint) return { curl: '' }
    const bodyJson = JSON.stringify(task.request_payload ?? {})
    return {
      curl: [
        `curl -X ${endpoint.method} ${shellSingleQuote(endpoint.url)} \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -H ${shellSingleQuote(`Authorization: Bearer ${apiKey}`)} \\`,
        `  -d ${shellSingleQuote(bodyJson)}`,
      ].join('\n'),
    }
  }

  // 找离线可用的文本模型（对齐在线 findChatModel）：启用平台下启用且 polish_model 的文本
  // 模型优先，回退 model_id='gpt-5.5'。返回该模型的 {baseUrl, apiKey, model}。
  private async resolveChatCreds(): Promise<{ baseUrl: string; apiKey: string; model: string }> {
    const providers = await idb.getAll<Provider>('providers')
    const enabledP = new Map(providers.filter((p) => p.enabled).map((p) => [p.id, p]))
    const models = await idb.getAll<Model>('models')
    const pick = models.find((m) => m.enabled && m.polish_model && enabledP.has(m.provider_id))
      || models.find((m) => m.enabled && m.model_id === 'gpt-5.5' && enabledP.has(m.provider_id))
    if (!pick) throw new Error('未找到可用文本模型，请先在平台页配置一个文本模型')
    const provider = enabledP.get(pick.provider_id)!
    const first = pick.keys?.find((k) => k.enabled !== false && k.key)
    return { baseUrl: provider.base_url, apiKey: first?.key || provider.api_key, model: pick.model_id }
  }

  async taskStats(): Promise<StatsRow[]> {
    // 本地按 provider+model 聚合（与在线 /api/tasks/stats 同形）。
    const tasks = (await idb.getAll<TaskRow & { deleted_at?: number | null }>('tasks')).filter((t) => !t.deleted_at)
    const map = new Map<string, StatsRow & { _lat: number[] }>()
    for (const t of tasks) {
      const key = `${t.provider_id}|${t.model_id}`
      let s = map.get(key)
      if (!s) {
        s = {
          provider_id: t.provider_id, provider_name: t.provider_name, api_format: t.api_format,
          kind: t.kind, model_id: t.model_id, model_name: t.model_name,
          total: 0, succeeded: 0, failed: 0, avg_latency_ms: null, last_run_at: null, success_rate: 0, _lat: [],
        }
        map.set(key, s)
      }
      s.total++
      if (t.status === 'succeeded') s.succeeded++
      if (t.status === 'failed') s.failed++
      if (t.latency_ms != null) s._lat.push(t.latency_ms)
      s.last_run_at = Math.max(s.last_run_at || 0, t.created_at)
    }
    return Array.from(map.values()).map(({ _lat, ...s }) => ({
      ...s,
      avg_latency_ms: _lat.length ? Math.round(_lat.reduce((a, b) => a + b, 0) / _lat.length) : null,
      success_rate: s.total ? s.succeeded / s.total : 0,
    }))
  }

  // ── 素材 Assets ─────────────────────────────────────────────────
  async listAssets(kind?: ModelKind): Promise<PickerAsset[]> {
    let assets = await idb.getAll<PickerAsset>('assets')
    if (kind) assets = assets.filter((a) => a.kind === kind)
    assets.sort((a, b) => b.created_at - a.created_at)
    return assets
  }

  async resolveRefIds(items: RefResolveItem[]): Promise<string[]> {
    const ids: string[] = []
    for (const it of items) {
      if (it.id) { ids.push(it.id); continue }
      if (it.file) {
        // 本地文件 → 读成 base64 data URL 存 IndexedDB，sha256 去重。
        const buf = new Uint8Array(await it.file.arrayBuffer())
        const sha = await sha256Hex(buf)
        const dup = (await idb.getAllByIndex<PickerAsset & { sha256?: string }>('assets', 'sha256', sha))[0]
        if (dup) { ids.push(dup.id); continue }
        const dataUrl = await fileToDataUrl(it.file)
        const asset: PickerAsset & { sha256: string } = {
          source: 'upload', id: sha, kind: it.kind, url: dataUrl,
          filename: it.file.name || null, mime: it.file.type || null, size: it.file.size,
          width: null, height: null, created_at: now(), sha256: sha,
        }
        await idb.put('assets', asset)
        ids.push(asset.id)
      } else if (it.public_url) {
        // 离线视频参考等：web URL 直接登记（不下载），id 用 URL 的 hash。
        const sha = await sha256Hex(new TextEncoder().encode(it.public_url))
        const dup = await idb.get<PickerAsset>('assets', sha)
        if (dup) { ids.push(sha); continue }
        const asset: PickerAsset & { sha256: string } = {
          source: 'upload', id: sha, kind: it.kind, url: it.public_url,
          filename: filenameFromUrl(it.public_url), mime: null, size: null,
          width: null, height: null, created_at: now(), sha256: sha,
        }
        await idb.put('assets', asset)
        ids.push(sha)
      } else {
        throw new Error('参考素材缺少可保存的文件或链接')
      }
    }
    return ids
  }

  async deleteAsset(id: string): Promise<void> {
    await idb.delete('assets', id)
  }

  async deleteTaskResult(_taskId: number, _idx: number): Promise<void> {
    // 离线暂不把生成结果登记为可复用素材，@ 选择器只有本地上传，故此处无对应素材可删。
  }

  // ── 提示词辅助 Prompt ────────────────────────────────────────────
  async polishPrompt(input: { prompt: string; kind: ModelKind; customCommand?: string }): Promise<{ polished?: string }> {
    const creds = await this.resolveChatCreds()
    const kind: 'image' | 'video' = input.kind === 'video' ? 'video' : 'image'
    return $fetch<{ polished?: string }>('/api/proxy/llm', {
      method: 'POST',
      body: { op: 'polish', ...creds, prompt: input.prompt, kind, customCommand: input.customCommand },
    })
  }
}

// ── 工具 ────────────────────────────────────────────────────────────
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const data = bytes.slice().buffer as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

function filenameFromUrl(url: string): string | null {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop()
    return last || null
  } catch { return null }
}
