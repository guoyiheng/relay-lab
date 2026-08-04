export type ApiFormat = 'openai-sync' | 'openai-async' | 'xai-image' | 'doubao-video' | 'full-url'
export type ModelKind = 'image' | 'video' | 'text'
// per_mtoken_video: 按量计费，但按"输入是否含视频"分两档单价（Seedance）。
export type PriceMode = 'per_call' | 'per_mtoken' | 'per_mtoken_video'
export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed'

// Ordered prompt content. Text runs + inline @-mention chips, in document
// order — the source of truth for multimodal interleaving (e.g. "image1
// wearing image2's clothes"). modelValue (string) stays a readable mirror
// where each chip renders as its "@N" label.
export type PromptSegment =
  | { type: 'text'; text: string }
  | { type: 'ref'; sig: string; kind: 'image' | 'video' | 'audio' }

// An asset shown in the picker / @-mention list — either an uploaded file or
// a generated result.
export interface PickerAsset {
  source: 'upload' | 'generated'
  id: string
  kind: 'image' | 'video' | 'audio'
  url: string
  filename: string | null
  mime: string | null
  size: number | null
  width: number | null
  height: number | null
  created_at: number
  meta?: {
    task_id?: number
    provider_name?: string
    model_name?: string
    prompt?: string
  }
}

export interface Provider {
  id: number
  name: string
  base_url: string
  api_key: string          // 明文 key（单用户内部工具，供编辑表单回填）
  api_key_masked: string
  api_format: ApiFormat
  enabled: boolean
  notes: string | null
  // Seedance 素材库控制面（AK/SK 直连 BytePlus 海外，仅 doubao-video 平台用）。
  ark_access_key: string | null
  ark_secret_key: string | null
  ark_region: string | null
  ark_project_name: string | null
  created_at: number
  updated_at: number
}

export interface ProviderInput {
  name: string
  base_url: string
  api_key: string
  api_format: ApiFormat
  enabled?: boolean
  notes?: string | null
  ark_access_key?: string | null
  ark_secret_key?: string | null
  ark_region?: string | null
  ark_project_name?: string | null
}

export interface ModelKeyEntry {
  name?: string         // 选填名称，便于区分
  key: string
  enabled: boolean
}

export interface Model {
  id: number
  provider_id: number
  provider_name?: string
  model_id: string
  display_name: string | null
  kind: ModelKind
  default_params: Record<string, unknown> | null
  enabled: boolean
  price_mode: PriceMode | null
  price_cny: number | null
  price_in_cny: number | null      // 按量计费 · 提示（输入）¥/M tokens
  price_out_cny: number | null     // 按量计费 · 补全（输出）¥/M tokens
  price_novideo_cny: number | null // per_mtoken_video · 输入不含视频 ¥/M tokens
  price_video_cny: number | null   // per_mtoken_video · 输入包含视频 ¥/M tokens
  polish_model: boolean            // 是否用于润色（互斥，仅一个）
  keys: ModelKeyEntry[] | null     // 模型独立 key（设了就不用平台 key）
  created_at: number
  updated_at: number
}

export interface ModelInput {
  provider_id: number
  model_id: string
  display_name?: string | null
  kind: ModelKind
  default_params?: Record<string, unknown> | null
  enabled?: boolean
  price_mode?: PriceMode | null
  price_cny?: number | null
  price_in_cny?: number | null
  price_out_cny?: number | null
  price_novideo_cny?: number | null
  price_video_cny?: number | null
  polish_model?: boolean
  keys?: ModelKeyEntry[] | null
}

export interface TaskRunInput {
  provider_id: number
  model_id: number
  prompt: string
  params?: Record<string, unknown>
}

export interface TaskRefAsset {
  asset_id: string
  filename: string | null
  public_url: string
  mime?: string | null
  size?: number | null
  width?: number | null
  height?: number | null
}

export interface TaskRow {
  id: number
  provider_id: number | null
  provider_name: string
  provider_base_url?: string | null
  model_id: number | null
  model_name: string
  kind: ModelKind
  api_format: ApiFormat
  prompt: string
  params: Record<string, unknown> | null
  request_payload: unknown
  response_payload: unknown
  status: TaskStatus
  http_status: number | null
  latency_ms: number | null
  remote_task_id: string | null
  result_urls: string[] | null
  result_text?: string | null
  error_message: string | null
  analysis?: unknown
  favorite?: boolean
  // 计价快照（下单时冻结，模型改价不影响历史任务成本）
  price_mode?: PriceMode | null
  price_cny?: number | null
  price_in_cny?: number | null
  price_out_cny?: number | null
  price_novideo_cny?: number | null
  price_video_cny?: number | null
  created_at: number
  updated_at: number
  finished_at: number | null
  assets_expires_at: number | null
  assets_cleaned_at: number | null
  assets_cleanup_reason: string | null
  refs?: { image: TaskRefAsset[]; video: TaskRefAsset[]; audio: TaskRefAsset[] }
}

export interface ProviderStats {
  provider_id: number | null
  provider_name: string
  total: number
  succeeded: number
  failed: number
  avg_latency_ms: number | null
  success_rate: number
}

// 平台 + 其下模型（列表接口的返回形态）。原先散落在 stores/pages 各自重复定义，
// 统一到此处，供 DataSource / stores / 页面共用。
export interface ProviderWithModels extends Provider {
  models: Model[]
}

// 任务列表查询条件（DataSource.listTasks 参数）。对应现有 /api/tasks 的 query：
// ids 优先（合并轮询批量拉取），否则按 provider_id/kind/status 过滤，limit 封顶。
export interface TaskListQuery {
  limit?: number
  ids?: number[]
  provider_id?: number | null
  kind?: 'image' | 'video' | null
  status?: 'succeeded' | 'failed' | null
}

// 参考素材提交前的解析项（DataSource.resolveRefIds 参数）。
//   · id 非空 → 已落库，直接复用
//   · file → 待上传本地文件
//   · public_url → 待导入远端 URL
export interface RefResolveItem {
  id: string
  kind: 'image' | 'video' | 'audio'
  public_url?: string
  file?: File
}

// 发起任务的完整入参（含已解析的参考 id 与有序 segments）。
export interface TaskRunPayload {
  provider_id: number
  model_id: number
  prompt: string
  params?: Record<string, unknown>
  refs?: { image: string[]; video: string[]; audio: string[] }
  segments?: Array<
    | { type: 'text'; text: string }
    | { type: 'ref'; upload_id: string; kind: 'image' | 'video' | 'audio' }
  >
}
