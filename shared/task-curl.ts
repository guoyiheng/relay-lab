import type { ApiFormat, ModelKind } from '../types/api'

export interface TaskEndpointInput {
  kind: ModelKind
  api_format: ApiFormat
  request_payload?: unknown
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function taskEndpoint(
  task: TaskEndpointInput,
  baseUrl: string,
): { method: 'POST'; url: string } | null {
  if (!baseUrl) return null
  if (task.api_format === 'full-url') return { method: 'POST', url: baseUrl }
  if (task.kind === 'text') return { method: 'POST', url: joinUrl(baseUrl, 'chat/completions') }
  if (task.api_format === 'seed-audio') {
    const clean = baseUrl.replace(/\/+$/, '')
    const path = clean.endsWith('/api/v3') ? 'tts/create' : 'api/v3/tts/create'
    return { method: 'POST', url: joinUrl(baseUrl, path) }
  }
  const resource = task.kind === 'image' ? 'images' : task.kind === 'audio' ? 'audio' : 'videos'
  if (task.api_format === 'doubao-video') {
    if (task.kind === 'image') {
      return { method: 'POST', url: joinUrl(baseUrl, 'images/generations') }
    }
    return { method: 'POST', url: joinUrl(baseUrl, 'contents/generations/tasks') }
  }
  if (task.api_format === 'openai-async') {
    return { method: 'POST', url: `${joinUrl(baseUrl, `${resource}/generations`)}?async=true` }
  }
  if (task.api_format === 'xai-image') {
    const payload = task.request_payload as Record<string, unknown> | null
    const isEdit = !!payload?.image || Array.isArray(payload?.images)
    return { method: 'POST', url: joinUrl(baseUrl, isEdit ? 'images/edits' : 'images/generations') }
  }
  return { method: 'POST', url: joinUrl(baseUrl, `${resource}/generations`) }
}
