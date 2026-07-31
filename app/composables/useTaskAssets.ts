/**
 * 任务结果素材的解析工具：从 task 记录里取出可展示的媒体 URL。
 * 控制台侧栏 / ResultViewer / 历史页共用，保证各处渲染同一份结果。
 */
import type { TaskRow } from '~~/types/api'

/**
 * Resolve the displayable result URLs for a task. Prefers the persisted
 * `result_urls`, but falls back to scraping `response_payload` for `url` /
 * `b64_json` when the stored list is empty (older rows or extractor gaps).
 * Shared by the console rail, ResultViewer, and history so every surface
 * renders the same media.
 */
export function scrapeResultUrls(obj: any): string[] {
  const out: string[] = []
  const visit = (v: any) => {
    if (v == null) return
    if (typeof v === 'string') {
      if (/^https?:\/\//i.test(v) && /\.(png|jpe?g|webp|gif|bmp|mp4|mov|webm|m3u8)(\?|$)/i.test(v)) out.push(v)
      return
    }
    if (Array.isArray(v)) { v.forEach(visit); return }
    if (typeof v === 'object') {
      for (const k of ['url', 'image_url', 'video_url', 'output_url', 'result_url']) {
        if (typeof v[k] === 'string' && /^https?:\/\//i.test(v[k])) out.push(v[k])
        else if (v[k] && typeof v[k] === 'object' && typeof v[k].url === 'string') out.push(v[k].url)
      }
      if (typeof v.b64_json === 'string' && v.b64_json.length > 0) out.push(`data:image/png;base64,${v.b64_json}`)
      for (const k of Object.keys(v)) {
        if (['url', 'image_url', 'video_url', 'output_url', 'result_url', 'b64_json'].includes(k)) continue
        visit(v[k])
      }
    }
  }
  visit(obj)
  return Array.from(new Set(out))
}

export function taskResultUrls(task: Pick<TaskRow, 'result_urls' | 'status' | 'response_payload' | 'assets_cleaned_at'> | null): string[] {
  if (!task || task.assets_cleaned_at) return []
  if (task.result_urls?.length) return task.result_urls
  if (task.status !== 'succeeded') return []
  return scrapeResultUrls(task.response_payload)
}

// Seedance video URLs expire after 24h. A video result is "expired" when it's
// still a remote upstream URL older than 24h. Results we persisted to R2
// (served from the asset domain or the /r2 proxy — path under results/ or
// uploads/) are ours and never expire; only un-persisted remote URLs do.
const VIDEO_TTL_MS = 24 * 60 * 60 * 1000
export function isVideoExpired(
  task: Pick<TaskRow, 'kind' | 'created_at'>,
  url: string,
): boolean {
  if (task.kind !== 'video') return false
  if (!/^https?:\/\//i.test(url)) return false   // relative /r2, /uploads or data: never expires
  if (/\/(r2|uploads|results)\//.test(url)) return false  // persisted to our R2 storage
  return Date.now() - task.created_at > VIDEO_TTL_MS
}

