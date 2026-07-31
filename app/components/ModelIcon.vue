<script setup lang="ts">
// 模型头像：按 modelId 生成稳定的渐变色块 + 首字母，无需真实图片。
import type { ModelKind } from '~~/types/api'

const props = withDefaults(defineProps<{
  modelId: string
  kind?: ModelKind
  size?: number
}>(), {
  size: 16,
})

// Lowercased substring → public asset path. Order matters (longer prefixes first).
// Each icon's SVG includes its own background — render natively, no tint.
const ICON_RULES: { match: RegExp; src: string }[] = [
  { match: /gpt-image|dall-e|^o1|gpt-/i,            src: '/model-icons/openai.png' },
  { match: /seedance|doubao|byteplus|^ep-/i,        src: '/model-icons/volcano.png' },
]

const icon = computed(() => {
  for (const r of ICON_RULES) if (r.match.test(props.modelId)) return r
  return null
})

const fallbackChar = computed(() => (props.modelId || '?').slice(0, 1).toUpperCase())
</script>

<template>
  <img
    v-if="icon"
    :src="icon.src"
    :alt="modelId"
    :width="size"
    :height="size"
    class="flex-shrink-0 rounded-[4px]"
    :style="{ width: size + 'px', height: size + 'px' }"
  />
  <span
    v-else
    class="grid flex-shrink-0 place-items-center rounded-[4px] bg-[var(--c-border-2)] text-[var(--c-fg-3)]"
    :style="{
      width: size + 'px',
      height: size + 'px',
      fontSize: Math.max(9, Math.floor(size * 0.45)) + 'px',
      fontWeight: 600,
    }"
  >{{ fallbackChar }}</span>
</template>
