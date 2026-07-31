<script setup lang="ts">
// Markdown 渲染：marked 解析 + highlight.js 代码高亮，用于文本模型结果展示。
import { marked } from 'marked'
import hljs from 'highlight.js/lib/common'

const props = defineProps<{ source: string }>()

// Configure marked once: fenced code blocks → highlight.js, with the detected
// language class so our theme CSS colours it.
marked.setOptions({
  breaks: true,
  gfm: true,
})

function renderCode(code: string, lang: string): string {
  const language = lang && hljs.getLanguage(lang) ? lang : ''
  try {
    const out = language
      ? hljs.highlight(code, { language }).value
      : hljs.highlightAuto(code).value
    return `<pre class="hljs-block"><code class="hljs language-${language || 'plaintext'}">${out}</code></pre>`
  } catch {
    return `<pre class="hljs-block"><code>${escapeHtml(code)}</code></pre>`
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]!)
}

const html = computed(() => {
  const renderer = new marked.Renderer()
  // marked v12 passes a token object; support both shapes defensively.
  renderer.code = ((arg: any, infostring?: string) => {
    const code = typeof arg === 'object' ? arg.text : arg
    const lang = typeof arg === 'object' ? (arg.lang || '') : (infostring || '')
    return renderCode(String(code ?? ''), String(lang || '').trim())
  }) as any
  try {
    return marked.parse(props.source || '', { renderer }) as string
  } catch {
    return escapeHtml(props.source || '')
  }
})
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="md-body" v-html="html" />
</template>

<style scoped>
.md-body {
  font-size: 14px;
  line-height: 1.7;
  color: var(--c-fg);
  word-break: break-word;
}
.md-body :deep(h1), .md-body :deep(h2), .md-body :deep(h3) { font-weight: 600; margin: 0.8em 0 0.4em; line-height: 1.3; }
.md-body :deep(h1) { font-size: 1.4em; }
.md-body :deep(h2) { font-size: 1.25em; }
.md-body :deep(h3) { font-size: 1.1em; }
.md-body :deep(p) { margin: 0.5em 0; }
.md-body :deep(ul), .md-body :deep(ol) { margin: 0.5em 0; padding-left: 1.4em; }
.md-body :deep(li) { margin: 0.2em 0; }
.md-body :deep(a) { color: var(--color-primary-500, #8b5cf6); text-decoration: underline; }
.md-body :deep(blockquote) {
  margin: 0.6em 0; padding: 0.2em 0.9em;
  border-left: 3px solid var(--c-border);
  color: var(--c-fg-4);
}
.md-body :deep(:not(pre) > code) {
  background: var(--c-surface-2);
  border: 1px solid var(--c-border-2);
  border-radius: 3px;
  padding: 0.1em 0.35em;
  font-family: 'Inconsolata', ui-monospace, monospace;
  font-size: 0.9em;
}
.md-body :deep(.hljs-block) {
  margin: 0.7em 0;
  border-radius: 6px;
  border: 1px solid var(--c-border);
  background: var(--c-surface-2);
  padding: 0.85em 1em;
  overflow-x: auto;
}
.md-body :deep(.hljs-block code) {
  font-family: 'Inconsolata', ui-monospace, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  background: none;
  border: none;
  padding: 0;
}
.md-body :deep(table) { border-collapse: collapse; margin: 0.6em 0; }
.md-body :deep(th), .md-body :deep(td) { border: 1px solid var(--c-border); padding: 0.3em 0.6em; }
.md-body :deep(hr) { border: none; border-top: 1px solid var(--c-border); margin: 0.8em 0; }
</style>
