<script setup lang="ts">
// 登录与邀请注册共用在线入口；离线模式无需账号，数据保存在本机浏览器。
import { OFFLINE_USER } from '~/composables/useAuth'
import { setDataMode } from '~/composables/useDataSource'

definePageMeta({ layout: 'auth' })

type AuthTab = 'login' | 'register'
type UseMode = 'online' | 'offline'

const route = useRoute()
const router = useRouter()
const activeTab = ref<AuthTab>('login')
const mode = ref<UseMode>('offline')
const showOnline = computed(() => {
  const queryMode = route.query.mode
  return (Array.isArray(queryMode) ? queryMode[0] : queryMode) === 'showOnline'
})
const me = useCurrentUser()

const username = ref('')
const password = ref('')
const submitting = ref(false)
const errorMsg = ref<string | null>(null)

const invite = ref('')
const email = ref('')
const registerPassword = ref('')
const confirmPassword = ref('')
const registerSubmitting = ref(false)
const registerSent = ref(false)
const registerErrorMsg = ref<string | null>(null)
const gameActive = ref(false)
const authCardPinned = ref(false)

watch(
  () => [route.query.tab, route.query.invite, showOnline.value] as const,
  ([tab, queryInvite, canShowOnline]) => {
    const inviteCode = String(Array.isArray(queryInvite) ? queryInvite[0] || '' : queryInvite || '')
    invite.value = inviteCode
    if (!canShowOnline) {
      mode.value = 'offline'
      activeTab.value = 'login'
      return
    }
    if (tab === 'register' || inviteCode) mode.value = 'online'
    activeTab.value = tab === 'register' || inviteCode ? 'register' : 'login'
  },
  { immediate: true },
)

function selectMode(nextMode: UseMode) {
  mode.value = nextMode
  errorMsg.value = null
  registerErrorMsg.value = null
}

function switchTab(tab: AuthTab) {
  activeTab.value = tab
  errorMsg.value = null
  registerErrorMsg.value = null
  void router.replace({ query: { ...route.query, tab } })
}

function handleGameActive(active: boolean) {
  gameActive.value = active
  authCardPinned.value = false
}

function pinAuthCard() {
  if (gameActive.value) authCardPinned.value = true
}

async function submitLogin() {
  errorMsg.value = null
  if (!username.value.trim() || !password.value) {
    errorMsg.value = '请填写账号和密码'
    return
  }
  submitting.value = true
  try {
    const res = await $fetch<{ id: number; username: string }>('/api/auth/login', {
      method: 'POST',
      body: { username: username.value, password: password.value },
    })
    setDataMode('online')
    me.value = { id: res.id, username: res.username, avatar: null, nickname: null }
    // 清空可能残留的离线 Pinia 缓存，确保加载当前在线账号的数据。
    window.location.assign('/')
  } catch (err: any) {
    errorMsg.value = err?.data?.statusMessage || err?.statusMessage || err?.message || '登录失败'
  } finally {
    submitting.value = false
  }
}

async function submitRegistration() {
  registerErrorMsg.value = null
  if (!email.value.trim() || !registerPassword.value || !invite.value.trim()) {
    registerErrorMsg.value = '请填写邮箱、密码和邀请码'
    return
  }
  if (registerPassword.value.length < 10) {
    registerErrorMsg.value = '密码至少需要 10 位'
    return
  }
  if (registerPassword.value !== confirmPassword.value) {
    registerErrorMsg.value = '两次输入的密码不一致'
    return
  }
  registerSubmitting.value = true
  try {
    await $fetch('/api/auth/register/request', {
      method: 'POST',
      body: { email: email.value, password: registerPassword.value, invite: invite.value.trim() },
    })
    registerSent.value = true
  } catch (err: any) {
    registerErrorMsg.value = err?.data?.statusMessage || err?.statusMessage || err?.message || '注册邮件发送失败'
  } finally {
    registerSubmitting.value = false
  }
}

function enterOffline() {
  setDataMode('offline')
  me.value = { ...OFFLINE_USER }
  // 整页刷新以隔离上一在线会话留在内存中的平台、任务与收藏数据。
  window.location.assign('/')
}
</script>

<template>
  <main
    class="relative isolate flex min-h-screen items-center justify-center overflow-hidden bg-[var(--c-surface)] px-4 py-8">
    <GomokuGame :paused="authCardPinned" @active-change="handleGameActive" />

    <section class="auth-card relative z-10 w-full max-w-md" :class="{
      'auth-card--docked': gameActive,
      'auth-card--pinned': authCardPinned,
    }" @click="pinAuthCard">
      <div class="auth-card-inner surface p-7 shadow-wf sm:p-8">
        <header class="mb-6 flex items-baseline gap-2">
          <span class="font-display text-[20px] font-semibold tracking-tightish text-primary-500">Relay</span>
          <span class="font-display text-[20px] font-semibold tracking-tightish text-[var(--c-fg)]">Lab</span>
        </header>

        <div v-if="showOnline" class="mb-5 grid grid-cols-2 rounded-[7px] bg-[var(--c-surface-2)] p-0.5"
          role="radiogroup" aria-label="使用方式">
          <button type="button" role="radio" :aria-checked="mode === 'offline'"
            class="flex items-center justify-center gap-1.5 rounded-[5px] px-3 py-2 text-[12px] font-medium transition-colors"
            :class="mode === 'offline' ? 'bg-[var(--c-surface)] text-[var(--c-fg)] shadow-sm' : 'text-[var(--c-fg-4)] hover:text-[var(--c-fg-2)]'"
            @click="selectMode('offline')">
            <UIcon name="i-carbon-cloud-offline" class="h-4 w-4" />
            离线使用
          </button>
          <button type="button" role="radio" :aria-checked="mode === 'online'"
            class="flex items-center justify-center gap-1.5 rounded-[5px] px-3 py-2 text-[12px] font-medium transition-colors"
            :class="mode === 'online' ? 'bg-[var(--c-surface)] text-[var(--c-fg)] shadow-sm' : 'text-[var(--c-fg-4)] hover:text-[var(--c-fg-2)]'"
            @click="selectMode('online')">
            <UIcon name="i-carbon-cloud" class="h-4 w-4" />
            在线使用
          </button>
        </div>

        <template v-if="mode === 'offline'">
          <h1 class="text-[18px] font-semibold text-[var(--c-fg)]">数据留在当前浏览器</h1>
          <p class="mt-2 text-[13px] leading-6 text-[var(--c-fg-4)]">
            平台配置、API Key 与测试记录保存在本机 IndexedDB，无需注册账号。
            为保证进行中任务不会丢失，生成请求仍会经本站无状态代理转发到你配置的上游 API。
          </p>
          <div
            class="mt-4 flex items-start gap-2 rounded-[6px] bg-[var(--c-surface-2)] px-3 py-2.5 text-[12px] leading-5 text-[var(--c-fg-4)]">
            <UIcon name="i-carbon-warning-alt" class="mt-0.5 h-4 w-4 flex-none text-amber-600" />
            <span>清除浏览器数据或更换设备会丢失本地配置和记录，测试后可及时删除测试 Key 避免泄露</span>
          </div>
          <UButton class="mt-6" color="primary" block icon="i-carbon-arrow-right" trailing @click="enterOffline">
            进入离线模式
          </UButton>
        </template>

        <template v-else>
          <p class="mb-5 text-[13px] leading-5 text-[var(--c-fg-4)]">
            配置与记录保存在服务器，登录后可跨设备访问，并使用服务端任务队列和素材存储。
          </p>

          <div class="mb-5 grid grid-cols-2 rounded-[7px] bg-[var(--c-surface-2)] p-0.5" role="tablist"
            aria-label="账号入口">
            <button type="button" role="tab" :aria-selected="activeTab === 'login'"
              class="rounded-[5px] px-3 py-1.5 text-[12px] font-medium transition-colors"
              :class="activeTab === 'login' ? 'bg-[var(--c-surface)] text-[var(--c-fg)] shadow-sm' : 'text-[var(--c-fg-4)] hover:text-[var(--c-fg-2)]'"
              @click="switchTab('login')">
              登录
            </button>
            <button type="button" role="tab" :aria-selected="activeTab === 'register'"
              class="rounded-[5px] px-3 py-1.5 text-[12px] font-medium transition-colors"
              :class="activeTab === 'register' ? 'bg-[var(--c-surface)] text-[var(--c-fg)] shadow-sm' : 'text-[var(--c-fg-4)] hover:text-[var(--c-fg-2)]'"
              @click="switchTab('register')">
              注册
            </button>
          </div>

          <div v-if="activeTab === 'login'" role="tabpanel">
            <h1 class="text-[18px] font-semibold text-[var(--c-fg)]">登录</h1>

            <form class="mt-6 space-y-4" @submit.prevent="submitLogin">
              <div>
                <label class="field-label">账号</label>
                <UInput v-model="username" autocomplete="username" placeholder="请输入账号" :disabled="submitting" />
              </div>
              <div>
                <label class="field-label">密码</label>
                <UInput v-model="password" type="password" autocomplete="current-password" placeholder="请输入密码"
                  :disabled="submitting" />
              </div>
              <UAlert v-if="errorMsg" :title="errorMsg" color="error" variant="soft" />
              <UButton type="submit" color="primary" block :loading="submitting" :disabled="submitting">
                {{ submitting ? '登录中...' : '登录' }}
              </UButton>
            </form>
          </div>

          <div v-else role="tabpanel">
            <div v-if="registerSent" class="py-8 text-center">
              <div class="mx-auto grid h-11 w-11 place-items-center rounded-full bg-emerald-50 text-emerald-700">
                <UIcon name="i-carbon-email" class="h-5 w-5" />
              </div>
              <h1 class="mt-5 text-[18px] font-semibold text-[var(--c-fg)]">验证邮件已发送</h1>
              <p class="mt-2 text-[13px] leading-6 text-[var(--c-fg-4)]">
                请前往 <strong class="text-[var(--c-fg-2)]">{{ email }}</strong> 完成验证，链接 15 分钟内有效。
              </p>
              <div class="mt-6 flex justify-center gap-4 text-[13px]">
                <button class="text-primary-600 hover:text-primary-700" @click="registerSent = false">重新填写</button>
                <button class="text-[var(--c-fg-4)] hover:text-[var(--c-fg-2)]"
                  @click="switchTab('login')">返回登录</button>
              </div>
            </div>

            <template v-else>
              <div class="mb-5 flex items-center justify-between gap-4">
                <h1 class="text-[18px] font-semibold text-[var(--c-fg)]">邮箱注册</h1>
              </div>

              <form class="space-y-4" @submit.prevent="submitRegistration">
                <div>
                  <label class="field-label required">邀请码</label>
                  <UInput v-model="invite" autocomplete="off" placeholder="请输入邀请码" :disabled="registerSubmitting" />
                </div>
                <div>
                  <label class="field-label required">邮箱</label>
                  <UInput v-model="email" type="email" autocomplete="email" placeholder="name@company.com"
                    :disabled="registerSubmitting" />
                </div>
                <div>
                  <label class="field-label required">密码</label>
                  <UInput v-model="registerPassword" type="password" autocomplete="new-password" placeholder="至少 10 位"
                    :disabled="registerSubmitting" />
                </div>
                <div>
                  <label class="field-label required">确认密码</label>
                  <UInput v-model="confirmPassword" type="password" autocomplete="new-password" placeholder="再次输入密码"
                    :disabled="registerSubmitting" />
                </div>

                <UAlert color="warning" variant="soft" icon="i-carbon-warning-alt" title="测试后请及时删除 Key，避免泄露"
                  description="" />
                <UAlert v-if="registerErrorMsg" :title="registerErrorMsg" color="error" variant="soft" />
                <UButton type="submit" color="primary" block :loading="registerSubmitting"
                  :disabled="registerSubmitting">
                  {{ registerSubmitting ? '发送中...' : '发送验证邮件' }}
                </UButton>
              </form>
            </template>
          </div>
        </template>
      </div>
    </section>
  </main>
</template>

<style scoped>
.auth-card {
  perspective: 1200px;
  transform-origin: center;
  transition: transform 430ms cubic-bezier(0.22, 1, 0.36, 1) 180ms;
  will-change: transform;
}

.auth-card::after {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #8b5cf6;
  content: 'R';
  font-family: var(--font-display);
  font-size: 160px;
  font-weight: 700;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
}

.auth-card-inner {
  transform-style: preserve-3d;
  transition: transform 260ms cubic-bezier(0.25, 1, 0.5, 1);
}

.auth-card--docked {
  cursor: pointer;
  transform: translateX(calc(50vw - 36px)) scale(0.1);
}

.auth-card--docked .auth-card-inner {
  transform: rotateY(180deg);
}

.auth-card--docked::after {
  opacity: 1;
  transition-delay: 520ms;
}

.auth-card--pinned {
  cursor: default;
  transform: translateX(0) scale(1);
  transition-delay: 0ms;
}

.auth-card--pinned .auth-card-inner {
  transform: rotateY(0deg);
}

.auth-card--pinned::after {
  opacity: 0;
  transition-delay: 0ms;
}

@media (prefers-reduced-motion: reduce) {

  .auth-card,
  .auth-card-inner {
    transition: none;
  }
}
</style>
