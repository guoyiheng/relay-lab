// 全局路由守卫：离线模式由本地模式 cookie 放行；在线模式继续使用服务端 session。
import { MODE_KEY } from '~/composables/useDataSource'
import { OFFLINE_USER } from '~/composables/useAuth'

export default defineNuxtRouteMiddleware(async (to) => {
  const me = useCurrentUser()
  const publicPaths = ['/login', '/register', '/register/verify']
  const isPublicPath = publicPaths.includes(to.path)

  // 离线模式没有服务端 session。登录页仍可访问，以便用户切回在线使用。
  if (useCookie(MODE_KEY).value === 'offline') {
    if (!me.value) me.value = { ...OFFLINE_USER }
    return
  }

  // 刚从离线切回在线时，清除本地虚拟用户并重新鉴权。
  if (me.value?.username === OFFLINE_USER.username) me.value = null

  // 公开入口且没有 session cookie 时，无需额外请求 /api/auth/me。
  const session = useCookie<string | null>('seedance_session')
  if (me.value === null && isPublicPath && !session.value) return

  if (me.value === null) {
    try {
      const headers = useRequestHeaders(['cookie'])
      const res = await $fetch<{ user: { id: number; username: string; avatar: string | null; nickname: string | null } | null }>('/api/auth/me', {
        headers,
      })
      me.value = res.user
    } catch {
      me.value = null
    }
  }
  if (!me.value && !isPublicPath) return navigateTo('/login')
  if (me.value && isPublicPath) return navigateTo('/')
})
