// Unified duration formatter — same concept, same unit everywhere.
// < 1s → "xxx ms"; < 60s → "x.x s"; ≥ 60s → "Xm XXs".
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return `${m}m ${r.toString().padStart(2, '0')}s`
}
