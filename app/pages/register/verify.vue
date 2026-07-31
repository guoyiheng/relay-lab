<script setup lang="ts">
definePageMeta({ layout: 'auth' })

const state = ref<'verifying' | 'success' | 'error'>('verifying')
const message = ref('正在确认邮箱并创建账号…')
const me = useCurrentUser()

onMounted(async () => {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') || ''
  history.replaceState(null, '', window.location.pathname)
  if (!token) {
    state.value = 'error'
    message.value = '验证链接无效'
    return
  }
  try {
    const user = await $fetch<{ id: number; username: string }>('/api/auth/register/verify', {
      method: 'POST', body: { token },
    })
    me.value = { id: user.id, username: user.username, avatar: null, nickname: null }
    state.value = 'success'
    message.value = '注册成功，正在进入 Relay Lab…'
    setTimeout(() => navigateTo('/'), 700)
  } catch (err: any) {
    state.value = 'error'
    message.value = err?.data?.statusMessage || err?.statusMessage || err?.message || '验证失败'
  }
})
</script>

<template>
  <main class="flex min-h-screen items-center justify-center bg-[var(--c-surface-2)] px-4">
    <section class="surface w-full max-w-md p-9 text-center shadow-wf">
      <div
        class="mx-auto grid h-12 w-12 place-items-center rounded-full"
        :class="state === 'error' ? 'bg-red-50 text-red-600' : state === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-primary-50 text-primary-700'"
      >
        <UIcon v-if="state === 'error'" name="i-carbon-close" class="h-5 w-5" />
        <UIcon v-else-if="state === 'success'" name="i-carbon-checkmark" class="h-5 w-5" />
        <UIcon v-else name="i-carbon-renew" class="h-5 w-5 animate-spin" />
      </div>
      <h1 class="mt-6 font-display text-[23px] font-semibold tracking-tight">邮箱验证</h1>
      <p class="mt-3 text-[14px] leading-6 text-[var(--c-fg-4)]">{{ message }}</p>
      <UButton v-if="state === 'error'" class="mt-7" variant="soft" to="/login">返回登录</UButton>
    </section>
  </main>
</template>
