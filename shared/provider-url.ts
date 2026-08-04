import type { ApiFormat } from '../types/api'

export function normalizeProviderUrl(raw: string, format: ApiFormat): string {
  const url = raw.trim()
  return format === 'full-url' ? url : url.replace(/\/+$/, '')
}
