import type { Provider, Model, TaskRow } from '~~/types/api'
import type { ProviderRecord, ModelRecord, TaskRecord } from './db'

export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '*'.repeat(key.length)
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

export function serializeProvider(row: ProviderRecord): Provider {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    // Single-user internal tool: return the raw key so the edit form can
    // prefill it (mirrors serializeModel, which returns model keys in clear).
    api_key: row.api_key,
    api_key_masked: maskKey(row.api_key),
    api_format: row.api_format,
    enabled: !!row.enabled,
    notes: row.notes,
    // Seedance 素材库控制面凭证（单用户内部工具，明文回填编辑表单，与 api_key 一致）。
    ark_access_key: row.ark_access_key,
    ark_secret_key: row.ark_secret_key,
    ark_region: row.ark_region,
    ark_project_name: row.ark_project_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function serializeModel(row: ModelRecord, providerName?: string): Model {
  let params: Record<string, unknown> | null = null
  if (row.default_params) {
    try {
      const parsed = JSON.parse(row.default_params)
      params = parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      params = null
    }
  }
  let keys: Model['keys'] = null
  if (row.keys) {
    try {
      const parsed = JSON.parse(row.keys)
      keys = Array.isArray(parsed) ? parsed : null
    } catch { keys = null }
  }
  return {
    id: row.id,
    provider_id: row.provider_id,
    provider_name: providerName,
    model_id: row.model_id,
    display_name: row.display_name,
    kind: row.kind,
    default_params: params,
    enabled: !!row.enabled,
    price_mode: row.price_mode,
    price_cny: row.price_cny,
    price_in_cny: row.price_in_cny ?? null,
    price_out_cny: row.price_out_cny ?? null,
    price_novideo_cny: row.price_novideo_cny ?? null,
    price_video_cny: row.price_video_cny ?? null,
    polish_model: !!row.polish_model,
    keys,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function safeJson(text: string | null): unknown {
  if (!text) return null
  try { return JSON.parse(text) } catch { return text }
}

// `live` carries the current provider/model NAMES joined by id. We prefer them
// over the stored snapshot so renames (e.g. Seedance→火山) reflect everywhere;
// snapshot is the fallback when the provider/model was since deleted.
// PRICE is intentionally NOT live — it's read from the task's own snapshot
// columns (frozen at insert time), so changing a model's price never rewrites
// the cost of past tasks.
export function serializeTask(
  row: TaskRecord,
  live?: {
    providerBaseUrl?: string | null
    providerName?: string | null
    modelName?: string | null
  },
): TaskRow {
  let urls: string[] | null = null
  if (row.result_urls) {
    try {
      const parsed = JSON.parse(row.result_urls)
      urls = Array.isArray(parsed) ? parsed : null
    } catch {
      urls = null
    }
  }
  let params: Record<string, unknown> | null = null
  if (row.params) {
    try {
      const parsed = JSON.parse(row.params)
      params = parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      params = null
    }
  }
  return {
    id: row.id,
    provider_id: row.provider_id,
    provider_name: live?.providerName || row.provider_name,
    provider_base_url: live?.providerBaseUrl ?? null,
    model_id: row.model_id,
    model_name: live?.modelName || row.model_name,
    kind: row.kind,
    api_format: row.api_format,
    prompt: row.prompt,
    params,
    request_payload: safeJson(row.request_payload),
    response_payload: safeJson(row.response_payload),
    status: row.status,
    http_status: row.http_status,
    latency_ms: row.latency_ms,
    remote_task_id: row.remote_task_id,
    result_urls: urls,
    result_text: row.result_text,
    error_message: row.error_message,
    analysis: safeJson(row.analysis),
    favorite: !!row.favorite,
    price_mode: row.price_mode ?? null,
    price_cny: row.price_cny ?? null,
    price_in_cny: row.price_in_cny ?? null,
    price_out_cny: row.price_out_cny ?? null,
    price_novideo_cny: row.price_novideo_cny ?? null,
    price_video_cny: row.price_video_cny ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
    assets_expires_at: row.assets_expires_at,
    assets_cleaned_at: row.assets_cleaned_at,
    assets_cleanup_reason: row.assets_cleanup_reason,
  }
}
