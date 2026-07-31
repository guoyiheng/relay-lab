import { defineStore } from 'pinia'
import type { TaskRow } from '~~/types/api'

export interface HistoryFilters {
  provider_id: number | null
  kind: 'image' | 'video' | null
  status: 'succeeded' | 'failed' | null
}

// 与 /api/tasks/stats 返回一致（history 页据此聚合展示）。
export interface StatsRow {
  provider_id: number | null
  provider_name: string
  api_format: string
  kind: string
  model_id: number | null
  model_name: string
  total: number
  succeeded: number
  failed: number
  avg_latency_ms: number | null
  last_run_at: number | null
  success_rate: number
}

function filterSig(f: HistoryFilters): string {
  return `${f.provider_id ?? ''}|${f.kind ?? ''}|${f.status ?? ''}`
}

/**
 * Caches the history page's task list + stats across navigations, so
 * re-entering the page (without new writes) reuses data instead of refetching.
 * Tasks depend on the active filters, so they're keyed by a filter signature;
 * stats are global (unfiltered) and cached on their own. `isStale` (30s) plus
 * an explicit `invalidate()` after deletes decide when a refresh is worth it.
 */
export const useHistoryStore = defineStore('history', {
  state: () => ({
    tasks: [] as TaskRow[],
    stats: [] as StatsRow[],
    tasksSig: '' as string,
    tasksLoadedAt: 0 as number,
    statsLoadedAt: 0 as number,
    loading: false as boolean,
  }),
  getters: {
    tasksStale: (s) => (sig: string) =>
      s.tasksLoadedAt === 0 || s.tasksSig !== sig || Date.now() - s.tasksLoadedAt > 30_000,
    statsStale: (s) => s.statsLoadedAt === 0 || Date.now() - s.statsLoadedAt > 30_000,
  },
  actions: {
    async load(filters: HistoryFilters, force = false) {
      if (this.loading) return
      const sig = filterSig(filters)
      const needTasks = force || this.tasksStale(sig)
      const needStats = force || this.statsStale
      if (!needTasks && !needStats) return
      this.loading = true
      try {
        const ds = useDataSource()
        const [t, s] = await Promise.all([
          needTasks
            ? ds.listTasks({ limit: 300, provider_id: filters.provider_id, kind: filters.kind, status: filters.status })
            : Promise.resolve(this.tasks),
          needStats ? ds.taskStats() : Promise.resolve(this.stats),
        ])
        if (needTasks) {
          this.tasks = t
          this.tasksSig = sig
          this.tasksLoadedAt = Date.now()
        }
        if (needStats) {
          this.stats = s
          this.statsLoadedAt = Date.now()
        }
      } finally {
        this.loading = false
      }
    },
    // 让缓存失效（删除记录后调用），下次 load 强制重新拉取。
    invalidate() {
      this.tasksLoadedAt = 0
      this.statsLoadedAt = 0
    },
  },
})
