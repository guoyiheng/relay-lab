import { defineStore } from 'pinia'
import type { ProviderWithModels } from '~~/types/api'

// ProviderWithModels 已提到 ~~/types/api 统一定义，这里 re-export 兼容旧引用路径。
export type { ProviderWithModels }

/**
 * Caches providers + their models across route changes. The console and
 * platforms / history pages all read from this store; the first page mount
 * does one `loadAll()` (fetch /api/providers) and subsequent navigations
 * reuse the cached list. Mutations (create / update / delete provider or
 * model) call `loadAll()` again to refresh.
 */
export const useProvidersStore = defineStore('providers', {
  state: () => ({
    providers: [] as ProviderWithModels[],
    loadedAt: 0 as number, // epoch ms; 0 = never loaded
    loading: false as boolean,
  }),
  getters: {
    isStale: (s) => s.loadedAt === 0 || Date.now() - s.loadedAt > 60_000,
    // 按平台名称升序（中文 localeCompare）。混音台/历史统一用此顺序。
    byName: (s) => [...s.providers].sort((a, b) => a.name.localeCompare(b.name, 'zh')),
    // 按创建时间倒序（与 /api/providers 默认一致，新建的在前）。
    byCreated: (s) => [...s.providers].sort((a, b) => b.created_at - a.created_at),
  },
  actions: {
    async loadAll(force = false) {
      if (this.loading) return
      if (!force && !this.isStale && this.providers.length) return
      this.loading = true
      try {
        this.providers = await useDataSource().listProviders()
        this.loadedAt = Date.now()
      } finally {
        this.loading = false
      }
    },
    invalidate() {
      this.loadedAt = 0
    },
  },
})
