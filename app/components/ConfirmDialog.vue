<script setup lang="ts">
// 由 useOverlay() 通过 overlay.create() 挂载：Nuxt UI v4 会自己控制打开状态并把
// close 事件收集为 open() 返回的 Promise。这里的 UModal 自身也用 v-model:open
// 双向控制，是为了在 backdrop/ESC 关闭时也能把结果 emit 出去（默认视为取消）。
defineProps<{
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}>()
const emit = defineEmits<{ close: [value: boolean] }>()

const open = ref(true)
function settle(ok: boolean) {
  open.value = false
  emit('close', ok)
}
function onOpenChange(v: boolean) {
  if (!v && open.value) settle(false)
}
</script>

<template>
  <UModal
    :open="open"
    :ui="{ content: 'sm:max-w-md', header: 'px-5 py-4', body: 'p-5', footer: 'px-5 py-4' }"
    @update:open="onOpenChange">
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon
          :name="danger ? 'i-carbon-warning-alt' : 'i-carbon-help'"
          class="h-5 w-5 shrink-0"
          :class="danger ? 'text-error-500' : 'text-primary-600'" />
        <h3 class="h-sub">{{ title }}</h3>
      </div>
    </template>
    <template #body>
      <p v-if="description" class="text-[14px] leading-relaxed text-[var(--c-fg-3)]">
        {{ description }}
      </p>
      <p v-else class="text-[14px] text-[var(--c-fg-4)]">此操作不可撤销，确认继续？</p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="outline" color="neutral" @click="settle(false)">
          {{ cancelText || '取消' }}
        </UButton>
        <UButton :color="danger ? 'error' : 'primary'" @click="settle(true)">
          {{ confirmText || '确定' }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
