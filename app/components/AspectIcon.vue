<script setup lang="ts">
// 比例小图标：把 "9:16" 这类比例字符串画成对应长宽比的矩形缩略图。
const props = defineProps<{ ratio: string }>()

const dims = computed(() => {
  const [w, h] = props.ratio.split(':').map(Number)
  if (!w || !h) return { w: 14, h: 14 }
  const max = 14
  if (w >= h) return { w: max, h: (h / w) * max }
  return { w: (w / h) * max, h: max }
})
</script>

<template>
  <span
    class="inline-block flex-shrink-0 border border-current"
    :style="{ width: `${dims.w}px`, height: `${dims.h}px` }"
    aria-hidden="true"
  />
</template>
