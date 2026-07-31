/**
 * useDataSource —— 数据层工厂（离线/在线切换的唯一入口）。
 *
 * stores / composables / 页面统一用 `useDataSource()` 取数据源，不再直接 $fetch。
 * 模式存 localStorage（登录页选择），据此返回对应实现：
 *   · online  → OnlineDataSource（薄包 /api/*）
 *   · offline → OfflineDataSource（IndexedDB + /api/proxy/*，后续步骤接入）
 *
 * 本步骤只落地在线实现，工厂恒返回 OnlineDataSource；离线实现就位后在此分支即可，
 * 上层调用点无需改动。
 */
import type { DataSource, DataMode } from '~/datasource/types'
import { OnlineDataSource } from '~/datasource/online'
import { OfflineDataSource } from '~/datasource/offline'

export const MODE_KEY = 'relay-data-mode'

/** 读取当前模式（默认 online）。SSR 无 localStorage 时回退 online。 */
export function getDataMode(): DataMode {
  if (import.meta.server) return 'online'
  return (localStorage.getItem(MODE_KEY) as DataMode) || 'online'
}

/**
 * 设置模式（登录页选择后调用）。localStorage 供 client 工厂读，同名 cookie 供
 * SSR 路由守卫读——两处同步，避免离线用户刷新时 SSR 误判未登录闪回 /login。
 */
export function setDataMode(mode: DataMode) {
  if (!import.meta.client) return
  localStorage.setItem(MODE_KEY, mode)
  // 一年有效、全站路径；非 httpOnly（前端要写），仅本机模式标记，无敏感信息。
  document.cookie = `${MODE_KEY}=${mode}; path=/; max-age=31536000; samesite=lax`
}

// 单例：同一模式复用同一实例（离线实现会持有 IndexedDB 连接，避免重复开）。
let cached: DataSource | null = null
let cachedMode: DataMode | null = null

export function useDataSource(): DataSource {
  const mode = getDataMode()
  if (cached && cachedMode === mode) return cached
  cached = mode === 'offline' ? new OfflineDataSource() : new OnlineDataSource()
  cachedMode = mode
  return cached
}
