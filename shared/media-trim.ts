export interface MediaTrimRange {
  start: number
  end: number
}

export function normalizeMediaTrim(start: number | null | undefined, end: number | null | undefined, duration: number): MediaTrimRange {
  if (!Number.isFinite(duration) || duration <= 0) return { start: 0, end: 0 }
  const gap = Math.min(0.1, duration)
  const safeEnd = end != null && Number.isFinite(end) && end > 0 ? Math.min(duration, end) : duration
  const safeStart = start != null && Number.isFinite(start) ? Math.max(0, start) : 0
  return { start: Math.min(safeStart, Math.max(0, safeEnd - gap)), end: safeEnd }
}

export function formatMediaTime(seconds: number): string {
  const tenths = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 10)
  const minutes = Math.floor(tenths / 600)
  return `${minutes}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`
}
