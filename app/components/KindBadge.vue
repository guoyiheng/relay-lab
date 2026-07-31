<script setup lang="ts">
// 类型徽标：生图 / 生视频 / 文本 的统一 icon + 文案胶囊，全站复用。
import type { ModelKind } from '~~/types/api'

const props = withDefaults(defineProps<{
  kind: ModelKind
  label?: boolean
  size?: 'sm' | 'xs'
}>(), {
  label: true,
  size: 'xs',
})

const icon = computed(() => ({ image: 'i-carbon-image', video: 'i-carbon-video', text: 'i-carbon-text-creation' } as Record<string, string>)[props.kind] || 'i-carbon-image')
const text = computed(() => ({ image: '图像', video: '视频', text: '文本' } as Record<string, string>)[props.kind] || props.kind)
</script>

<template>
  <span
    class="inline-flex items-center gap-1 rounded-[2px] bg-primary-50 px-1.5 py-0.5 font-medium text-primary-700"
    :class="size === 'sm' ? 'text-[12px]' : 'text-[11px]'"
  >
    <UIcon :name="icon" :class="size === 'sm' ? 'h-3.5 w-3.5' : 'h-3 w-3'" />
    <span v-if="label">{{ text }}</span>
  </span>
</template>
