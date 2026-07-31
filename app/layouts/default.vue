<script setup lang="ts">
// 主布局：顶部导航 + 深浅色切换 + 全屏查看器挂载点，登录后所有页面共用。
import { startPageTracking, endPageTracking, trackButtonClick } from '~/composables/useAnalytics'
import { getDataMode } from '~/composables/useDataSource'

const me = useCurrentUser()
const route = useRoute()
const menuOpen = ref(false)
const versionId = ref('')

// 离线模式标记：头部显示徽标，且隐藏依赖服务端 session 的入口（个人中心）。
const isOffline = ref(false)
onMounted(() => { isOffline.value = getDataMode() === 'offline' })

// Theme toggle via NuxtUI colorMode (adds/removes `.dark` on <html>).
const colorMode = useColorMode()
const mounted = ref(false)
onMounted(() => {
  mounted.value = true
  $fetch<{ version_id: string }>('/api/version').then((r) => { versionId.value = r.version_id }).catch(() => { })
})
const isDark = computed(() => colorMode.value === 'dark')
function toggleTheme() {
  colorMode.preference = isDark.value ? 'light' : 'dark'
}

const navItems = computed(() => {
  return [
    { to: '/', label: '混音台' },
    { to: '/providers', label: '平台' },
    { to: '/history', label: '历史' },
  ]
})

// 成本表和埋点仅 xxn 用户可见，收进头像折叠菜单。
const adminMenuItems = computed(() => {
  if (me.value?.username !== 'xxn') return []
  return [
    { to: '/cost', label: '成本表', icon: 'i-carbon-currency' },
    { to: '/analytics', label: '埋点', icon: 'i-carbon-chart-line' },
  ]
})

function goAdmin(to: string) {
  menuOpen.value = false
  navigateTo(to)
}

function openProfile() {
  trackButtonClick('profile')
  menuOpen.value = false
  navigateTo('/profile')
}

async function onLogout() {
  trackButtonClick('logout')
  menuOpen.value = false
  await logoutAndRedirect()
}

function toggleMenu() {
  menuOpen.value = !menuOpen.value
}

function onDocClick(e: MouseEvent) {
  if (!menuOpen.value) return
  const target = e.target as HTMLElement | null
  if (target?.closest('[data-account-menu]')) return
  menuOpen.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  startPageTracking(route.path)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  endPageTracking(route.path)
})

watch(() => route.path, (newPath, oldPath) => {
  if (oldPath) endPageTracking(oldPath)
  startPageTracking(newPath)
})
</script>

<template>
  <div class="flex h-screen min-h-0 flex-col overflow-hidden bg-[var(--c-surface)]">
    <header class="z-30 border-b border-[var(--c-border)] bg-[var(--c-surface)]">
      <div class="flex h-14 items-center justify-between px-6">
        <div class="flex items-center gap-8">
          <NuxtLink to="/" class="flex items-center gap-2">
            <UIcon name="i-carbon-ml-model-reference" class="h-6 w-6 text-primary-600" />
            <span class="font-display text-[18px] font-semibold tracking-tightish text-primary-600">Relay Lab</span>
            <span class="ml-0.5 hidden text-[12px] text-[var(--c-fg-6)] sm:inline">中转实验室</span>
          </NuxtLink>
          <span v-if="isOffline"
            class="inline-flex items-center gap-1 rounded-[3px] border border-[var(--c-border)] bg-[var(--c-surface-2)] px-1.5 py-0.5 text-[11px] text-[var(--c-fg-4)]"
            title="配置与记录只存本机浏览器">
            <UIcon name="i-carbon-cloud-offline" class="h-3 w-3" />离线
          </span>
          <nav class="flex items-center gap-1">
            <NuxtLink v-for="item in navItems" :key="item.to" :to="item.to"
              class="rounded-[4px] px-3 py-1.5 text-[14px] font-medium transition" :class="route.path === item.to
                ? 'bg-primary-50 text-primary-700'
                : 'text-[var(--c-fg-3)] hover:bg-[var(--c-surface-2)] hover:text-[var(--c-fg)]'">
              {{ item.label }}
            </NuxtLink>
          </nav>
        </div>
        <div class="flex items-center gap-2">
          <!-- <button
            type="button"
            class="icon-btn-ghost"
            :title="mounted && isDark ? '切换浅色' : '切换深色'"
            @click="toggleTheme"
          >
            <UIcon :name="mounted && isDark ? 'i-carbon-sun' : 'i-carbon-moon'" class="h-4 w-4" />
          </button> -->
          <div v-if="me" class="relative" data-account-menu>
            <button type="button"
              class="flex items-center gap-2 rounded-[4px] px-2 py-1 transition hover:bg-[var(--c-surface-2)]"
              :class="{ 'bg-[var(--c-surface-2)]': menuOpen }" @click="toggleMenu">
              <div
                class="grid h-7 w-7 place-items-center rounded-full bg-primary-500 text-[12px] font-medium text-white overflow-hidden">
                <img v-if="me.avatar" :src="me.avatar" class="h-full w-full object-cover" alt="avatar" />
                <span v-else>{{ (me.nickname || me.username).slice(0, 1).toUpperCase() }}</span>
              </div>
              <span class="hidden text-[14px] text-[var(--c-fg)] sm:inline">{{ me.nickname || me.username }}</span>
              <UIcon name="i-carbon-chevron-down" class="h-3 w-3 text-[var(--c-fg-4)] transition"
                :class="{ 'rotate-180': menuOpen }" />
            </button>
            <div v-if="menuOpen"
              class="absolute right-0 top-full z-40 mt-1 w-44 overflow-hidden rounded-[6px] border border-[var(--c-border)] bg-[var(--c-surface)] shadow-wf">
              <template v-if="adminMenuItems.length">
                <button v-for="item in adminMenuItems" :key="item.to" type="button"
                  class="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[14px] text-[var(--c-fg-2)] transition hover:bg-[var(--c-surface-2)]"
                  @click="goAdmin(item.to)">
                  <UIcon :name="item.icon" class="h-4 w-4 text-[var(--c-fg-4)]" />
                  {{ item.label }}
                </button>
                <div class="my-1 border-t border-[var(--c-border-2)]" />
              </template>
              <button v-if="!isOffline" type="button"
                class="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[14px] text-[var(--c-fg-2)] transition hover:bg-[var(--c-surface-2)]"
                @click="openProfile">
                <UIcon name="i-carbon-user" class="h-4 w-4 text-[var(--c-fg-4)]" />
                个人中心
              </button>
              <button type="button"
                class="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[14px] text-[var(--c-fg-2)] transition hover:bg-[var(--c-surface-2)]"
                @click="onLogout">
                <UIcon name="i-carbon-logout" class="h-4 w-4 text-[var(--c-fg-4)]" />
                {{ isOffline ? '退出离线' : '退出登录' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>
    <main class="h-full min-h-0 w-full flex-1 overflow-hidden px-4 pb-4 pt-3">
      <slot />
    </main>
    <footer
      class="flex h-8 shrink-0 items-center justify-center gap-4 border-t border-[var(--c-border)] bg-[var(--c-surface)] text-[12px] text-[var(--c-fg-4)]">
      <span>&copy; 2026 yiheng</span>
      <span v-if="versionId" class="font-mono text-[11px] text-[var(--c-fg-7)]" title="Cloudflare Workers 版本">{{
        versionId
        }}</span>
    </footer>
    <!-- Global fullscreen media overlay (driven by useFullscreenViewer) -->
    <FullscreenViewer />
  </div>
</template>
