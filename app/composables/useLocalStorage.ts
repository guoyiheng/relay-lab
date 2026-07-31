/**
 * localStorage 读写工具（SSR 安全）。
 * 统一项目里散落的 readStore/writeStore + JSON parse/stringify 样板，
 * 供 index.vue 参数持久化、usePromptFavorites 等复用。
 */

/** 读一个 JSON 对象值；无值/解析失败/非对象 → 返回空对象。 */
export function readStore<T = any>(key: string): Record<string, T> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const v = JSON.parse(raw)
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, T> : {}
  } catch { return {} }
}

/** 读一个 JSON 数组值；无值/解析失败/非数组 → 返回空数组。 */
export function readArray<T = any>(key: string): T[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(key)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v as T[] : []
  } catch { return [] }
}

/** 写任意值为 JSON；配额溢出等异常静默忽略。 */
export function writeStore(key: string, value: unknown) {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* quota */ }
}
