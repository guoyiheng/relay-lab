<script setup lang="ts">
// JsonTree 的递归节点：渲染单个键值，对象/数组可折叠，自身再递归子节点。
interface NodeShape {
  key: string | null
  type: 'object' | 'array' | 'primitive'
  preview: string
  count?: number
  children?: { key: string; value: unknown }[]
  raw: unknown
}

const props = defineProps<{
  node: NodeShape
  level: number
  defaultExpandDepth: number
  isRoot?: boolean
}>()

const open = ref(props.level < props.defaultExpandDepth)

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
    const short = value.length > 200 ? value.slice(0, 200) + '…' : value
    return { key, type: 'primitive', preview: JSON.stringify(short), raw: value }
  }
  return { key, type: 'primitive', preview: String(value), raw: value }
}

function primitiveClass(v: unknown) {
  if (v === null) return 'val-null'
  const t = typeof v
  if (t === 'string') return 'val-string'
  if (t === 'number') return 'val-number'
  if (t === 'boolean') return 'val-bool'
  return 'val-default'
}

const isContainer = computed(() => props.node.type === 'object' || props.node.type === 'array')
const isEmpty = computed(() => isContainer.value && (props.node.children?.length ?? 0) === 0)

function toggle() {
  if (!isContainer.value || isEmpty.value) return
  open.value = !open.value
}
</script>

<template>
  <div>
    <div class="row">
      <span
        class="toggle"
        :class="[open ? 'open' : '', isEmpty || !isContainer ? 'empty' : '']"
        @click="toggle"
      >
        <svg viewBox="0 0 24 24" class="h-3 w-3" fill="currentColor">
          <path d="M9 6l6 6-6 6z" />
        </svg>
      </span>
      <span v-if="node.key !== null" class="key">"{{ node.key }}"</span>
      <span v-if="node.key !== null" class="colon">:</span>
      <template v-if="isContainer">
        <span class="bracket">{{ node.type === 'array' ? '[' : '{' }}</span>
        <span v-if="!open" class="preview">{{ node.preview }}</span>
        <span v-if="!open" class="bracket">{{ node.type === 'array' ? ']' : '}' }}</span>
      </template>
      <template v-else>
        <span :class="primitiveClass(node.raw)">{{ node.preview }}</span>
      </template>
    </div>
    <div v-if="isContainer && open && !isEmpty" class="children">
      <JsonNode
        v-for="c in node.children"
        :key="c.key"
        :node="describe(c.value, c.key)"
        :level="level + 1"
        :default-expand-depth="defaultExpandDepth"
      />
    </div>
    <!-- Closing bracket aligns with the opening line (outside .children indent). -->
    <div v-if="isContainer && open && !isEmpty" class="row">
      <span class="toggle empty"></span>
      <span class="bracket">{{ node.type === 'array' ? ']' : '}' }}</span>
    </div>
  </div>
</template>
