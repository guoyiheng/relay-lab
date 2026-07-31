<script setup lang="ts">
// 个人中心：昵称 / 头像 / 密码修改。头像走素材上传，保存后刷新全局 current-user。
definePageMeta({ layout: 'default' })

const me = useCurrentUser()
const saving = ref(false)
const error = ref<string | null>(null)
const success = ref<string | null>(null)

const form = ref({
  nickname: '',
  avatar: '',
  currentPassword: '',
  newPassword: '',
})

onMounted(() => {
  if (me.value) {
    form.value.nickname = me.value.nickname || ''
    form.value.avatar = me.value.avatar || ''
  }
})

const avatarInputRef = ref<HTMLInputElement | null>(null)

function selectAvatar() {
  avatarInputRef.value?.click()
}

async function onAvatarChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  // 限制图片大小，避免 base64 过大
  if (file.size > 2 * 1024 * 1024) {
    error.value = '头像图片不能超过 2MB'
    return
  }

  const reader = new FileReader()
  reader.onload = (e) => {
    form.value.avatar = e.target?.result as string
  }
  reader.readAsDataURL(file)
}

async function saveProfile() {
  error.value = null
  success.value = null
  if (form.value.newPassword && (form.value.newPassword.length < 10 || form.value.newPassword.length > 128)) {
    error.value = '密码长度需为 10–128 位'
    return
  }
  saving.value = true

  try {
    const body: Record<string, unknown> = {}
    if (form.value.nickname !== (me.value?.nickname || '')) {
      body.nickname = form.value.nickname
    }
    if (form.value.avatar !== (me.value?.avatar || '')) {
      body.avatar = form.value.avatar
    }
    if (form.value.newPassword) {
      body.currentPassword = form.value.currentPassword
      body.newPassword = form.value.newPassword
    }

    if (Object.keys(body).length === 0) {
      success.value = '没有修改'
      return
    }

    await $fetch('/api/auth/profile', {
      method: 'PATCH',
      body,
    })

    // 刷新用户信息
    await fetchCurrentUser()

    // 清空密码字段
    form.value.currentPassword = ''
    form.value.newPassword = ''

    success.value = '保存成功'
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.statusMessage || err?.message || '保存失败'
  } finally {
    saving.value = false
  }
}

function removeAvatar() {
  form.value.avatar = ''
}
</script>

<template>
  <div class="mx-auto flex max-w-2xl flex-col gap-6 py-6">
    <div>
      <h1 class="text-[20px] font-semibold text-[var(--c-fg)]">个人中心</h1>
      <p class="mt-1 text-[13px] text-[var(--c-fg-4)]">管理您的个人信息和账户设置</p>
    </div>

    <UAlert v-if="error" :title="error" color="error" variant="soft" />
    <UAlert v-if="success" :title="success" color="success" variant="soft" />

    <div class="surface space-y-6 p-6">
      <!-- 头像 -->
      <div>
        <div class="field-label">头像</div>
        <div class="flex items-center gap-4">
          <div class="grid h-16 w-16 place-items-center rounded-full bg-primary-500 text-[24px] font-medium text-white overflow-hidden">
            <img v-if="form.avatar" :src="form.avatar" class="h-full w-full object-cover" alt="avatar" />
            <span v-else>{{ (form.nickname || me?.username || 'U').slice(0, 1).toUpperCase() }}</span>
          </div>
          <div class="flex gap-2">
            <input ref="avatarInputRef" type="file" accept="image/*" class="hidden" @change="onAvatarChange">
            <UButton size="sm" variant="outline" color="neutral" @click="selectAvatar">
              上传头像
            </UButton>
            <UButton v-if="form.avatar" size="sm" variant="ghost" color="error" @click="removeAvatar">
              移除
            </UButton>
          </div>
        </div>
        <p class="field-hint">支持 JPG、PNG 格式，建议尺寸 200×200，不超过 2MB</p>
      </div>

      <!-- 昵称 -->
      <div>
        <div class="field-label">昵称</div>
        <UInput v-model="form.nickname" placeholder="可选" />
        <p class="field-hint">昵称将显示在右上角账户菜单中</p>
      </div>

      <!-- 账号信息（只读） -->
      <div>
        <div class="field-label">账号</div>
        <UInput :model-value="me?.username" disabled />
      </div>

      <div class="border-t border-[var(--c-border)] pt-6">
        <h3 class="text-[16px] font-semibold text-[var(--c-fg)]">修改密码</h3>
        <div class="mt-4 space-y-4">
          <div>
            <div class="field-label">当前密码</div>
            <UInput v-model="form.currentPassword" type="password" placeholder="验证当前密码" />
          </div>
          <div>
            <div class="field-label">新密码</div>
            <UInput v-model="form.newPassword" type="password" autocomplete="new-password" minlength="10"
              maxlength="128" placeholder="留空则不修改密码" />
            <p class="field-hint">10–128 位；修改后其他设备上的会话将退出。</p>
          </div>
        </div>
      </div>

      <div class="flex justify-end gap-2">
        <UButton color="primary" :loading="saving" @click="saveProfile">
          保存修改
        </UButton>
      </div>
    </div>
  </div>
</template>
