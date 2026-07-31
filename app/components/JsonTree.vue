<script setup lang="ts">
// 可折叠 JSON 树的入口组件：把任意值渲染成层级可展开的树，递归交给 JsonNode。
const props = defineProps<{
  data: unknown
  /** Auto-expand depth (0 = root only collapsed, 1 = root open + children collapsed). Default 1. */
  defaultExpandDepth?: number
}>()

const depth = computed(() => props.defaultExpandDepth ?? 1)

interface NodeShape {
  key: string | null
  type: 'object' | 'array' | 'primitive'
  preview: string
  count?: number
  children?: { key: string; value: unknown }[]
  raw: unknown
}

function describe(value: unknown, key: string | null = null): NodeShape {
  if (value === null) return { key, type: 'primitive', preview: 'null', raw: value }
  if (Array.isArray(value)) {
    return {
      key,
      type: 'array',
      count: value.length,
      preview: `Array(${value.length})`,
      children: value.map((v, i) => ({ key: String(i), value: v })),
      raw: value,
    }
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    return {
      key,
      type: 'object',
      count: keys.length,
      preview: `{ ${keys.length} ${keys.length === 1 ? 'key' : 'keys'} }`,
      children: keys.map((k) => ({ key: k, value: (value as Record<string, unknown>)[k] })),
      raw: value,
    }
  }
  if (typeof value === 'string') {
    const short = value.length > 80 ? value.slice(0, 80) + '…' : value
    return { key, type: 'primitive', preview: JSON.stringify(short), raw: value }
  }
  return { key, type: 'primitive', preview: String(value), raw: value }
}

function valueClass(t: string) {
  if (t === 'string') return 'val-string'
  if (t === 'number') return 'val-number'
  if (t === 'boolean') return 'val-bool'
  if (t === 'null') return 'val-null'
  return 'val-default'
}

function primitiveType(v: unknown) {
  if (v === null) return 'null'
  return typeof v
}

const root = computed(() => describe(props.data))
</script>

<template>
  <div class="json-tree font-mono text-[12px] leading-relaxed">
    <JsonNode :node="root" :level="0" :default-expand-depth="depth" :is-root="true" />
  </div>
</template>

<style scoped>
.json-tree :deep(.row) {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 1px 0;
}
.json-tree :deep(.toggle) {
  width: 14px;
  display: inline-flex;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  color: rgba(8, 8, 8, 0.45);
  transition: transform 120ms ease;
}
.json-tree :deep(.toggle.open) { transform: rotate(90deg); }
.json-tree :deep(.toggle.empty) { cursor: default; opacity: 0; }
.json-tree :deep(.key) { color: var(--color-primary-500, #8b5cf6); font-weight: 500; }
.json-tree :deep(.colon) { color: var(--c-fg-7); margin: 0 4px 0 0; }
.json-tree :deep(.bracket) { color: var(--c-fg-7); }
.json-tree :deep(.preview) { color: var(--c-fg-7); font-style: italic; }
.json-tree :deep(.val-string) { color: var(--c-fg); word-break: break-all; }
.json-tree :deep(.val-number) { color: #ff6b00; }
.json-tree :deep(.val-bool) { color: #a78bfa; }
.json-tree :deep(.val-null) { color: var(--c-fg-7); }
.json-tree :deep(.val-default) { color: var(--c-fg); }
.json-tree :deep(.children) {
  padding-left: 14px;
  border-left: 1px solid var(--c-border-2);
  margin-left: 6px;
}
</style>
