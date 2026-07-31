<script setup lang="ts">
// Lightweight shimmer skeleton — a stack of pulsing bars. Used while data
// loads so the page reads as "working" instead of frozen.
withDefaults(defineProps<{ rows?: number; class?: string }>(), { rows: 6 })
</script>

<template>
  <div class="space-y-2 px-5 py-4" :class="$props.class">
    <div v-for="r in rows" :key="r" class="flex items-center gap-3">
      <div class="h-9 w-12 flex-shrink-0 animate-pulse rounded-[4px] bg-[var(--c-surface-3)]" />
      <div class="flex-1 space-y-1.5">
        <div class="h-3 animate-pulse rounded bg-[var(--c-surface-3)]" :style="{ width: `${55 + (r * 7) % 35}%` }" />
        <div class="h-2.5 animate-pulse rounded bg-[var(--c-surface-3)]" :style="{ width: `${30 + (r * 11) % 30}%` }" />
      </div>
      <div class="h-3 w-12 flex-shrink-0 animate-pulse rounded bg-[var(--c-surface-3)]" />
    </div>
  </div>
</template>
