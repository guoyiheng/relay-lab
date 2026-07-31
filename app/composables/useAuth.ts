/**
 * 当前登录用户的全局状态与鉴权动作。
 * useCurrentUser 用 useState 做跨组件单例；fetch/logout 与后端 /api/auth 对接。
 */
interface MeUser { id: number; username: string; avatar: string | null; nickname: string | null }

export const useCurrentUser = () => useState<MeUser | null>('current-user', () => null)

// 离线模式的本地虚拟用户：没有服务端 session，仅用于让依赖 me 的 UI（头像/菜单）
// 正常渲染。username 特意用 __offline__，不会命中任何 admin 判断（如 xxn 成本表）。
export const OFFLINE_USER: MeUser = { id: 0, username: '__offline__', avatar: null, nickname: '离线模式' }

export async function fetchCurrentUser(): Promise<MeUser | null> {
  const me = useCurrentUser()
  // 离线模式没有服务端 session，不打 /api/auth/me，保留本地虚拟用户。
  if (getDataMode() === 'offline') {
    if (!me.value) me.value = { ...OFFLINE_USER }
    return me.value
  }
  try {
    const res = await $fetch<{ user: MeUser | null }>('/api/auth/me')
    me.value = res.user
  } catch {
    me.value = null
  }
  return me.value
}

export async function logoutAndRedirect() {
  const me = useCurrentUser()
  // 退出统一整页硬跳转到登录页：清空 Pinia 内存缓存，避免上一会话(尤其是在线账号
  // 的平台/任务/收藏)残留到下一个会话或离线模式，造成越权可见。
  if (getDataMode() === 'offline') {
    // 离线模式无服务端 session：只清模式标记 + 本地用户，不打 /api/auth。
    setDataMode('online')
    me.value = null
    window.location.assign('/login')
    return
  }
  try { await $fetch('/api/auth/logout', { method: 'POST' }) } catch { /* ignore */ }
  me.value = null
  window.location.assign('/login')
}
