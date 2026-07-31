import { zip, strToU8, type Zippable } from 'fflate'
import type { TaskRow, Model } from '~~/types/api'
import { taskResultUrls } from './useTaskAssets'
import { computeTaskCost, formatCost } from './useTaskCost'
import { statusLabel, kindLabel } from './useTaskLabels'
import { useDownloadProgress } from './useDownloadProgress'

// fflate 的异步 zip 用 worker 压缩，主线程不阻塞（进度条不会卡住）。Promise 化调用。
function zipAsync(files: Zippable, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, { level }, (err, data) => (err ? reject(err) : resolve(data)))
  })
}

// 拉取远端媒体字节。结果/参考素材都在 R2 资产域（assets.relay.yiheng.run）或上游视频主机，
// 属跨域；浏览器直连 fetch 常被 CORS 拦（抛错）或返回非 2xx（把错误 body 当图写坏）。
// 故：先试同源/带 CORS 的直连，失败或非 2xx 时改走同源下载代理（/api/assets/download）取字节。
// data: URL 直连即可成功（代理只放行 http(s)），不会走到代理分支。
async function fetchBytes(url: string): Promise<Uint8Array> {
  try {
    const res = await fetch(url)
    if (res.ok) return new Uint8Array(await res.arrayBuffer())
  } catch { /* 跨域 / 网络失败：落到代理 */ }
  const res = await fetch(`/api/assets/download?url=${encodeURIComponent(url)}`)
  if (!res.ok) throw new Error(`proxy ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

// 把单个任务打包成一组文件（路径 → 字节）。prefix 用于批量下载时按任务分文件夹。
// 内容：生成结果媒体 + readme.md（概览 + 网络）+ prompt.txt（提示词）+ 参考素材。
async function collectTaskFiles(
  t: TaskRow,
  model: Model | null,
  prefix = '',
): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {}
  const p = (name: string) => `${prefix}${name}`

  // 1) 生成结果媒体
  const urls = taskResultUrls(t)
  let idx = 0
  for (const url of urls) {
    idx++
    const ext = t.kind === 'image' ? 'png' : t.kind === 'video' ? 'mp4' : 'bin'
    try {
      files[p(`result-${idx}.${ext}`)] = await fetchBytes(url)
    } catch {
      // 拉取失败（如视频已过期）：留个 .url 文件记录原始地址
      files[p(`result-${idx}.url.txt`)] = strToU8(url)
    }
  }
  // 文本模型结果
  if (t.result_text) files[p('result.md')] = strToU8(t.result_text)

  // 2) 参考素材
  const refGroups: [string, { public_url: string; filename: string | null }[]][] = [
    ['image', t.refs?.image || []],
    ['video', t.refs?.video || []],
    ['audio', t.refs?.audio || []],
  ]
  for (const [kind, list] of refGroups) {
    let ri = 0
    for (const r of list) {
      ri++
      try {
        const buf = await fetchBytes(r.public_url)
        const ext = (r.filename?.split('.').pop() || (kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'bin')).toLowerCase()
        files[p(`reference/${kind}-${ri}.${ext}`)] = buf
      } catch { /* skip unreachable ref */ }
    }
  }

  // 3) prompt.txt
  files[p('prompt.txt')] = strToU8(t.prompt || '')

  // 4) readme.md（概览 + 网络）
  files[p('readme.md')] = strToU8(buildReadme(t, model))

  return files
}

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

function buildReadme(t: TaskRow, model: Model | null): string {
  const cost = computeTaskCost(t, model)

  const lines: string[] = []
  lines.push(`# 任务 #${t.id}`, '')
  lines.push('## 概览', '')
  lines.push(`- 平台：${t.provider_name}`)
  lines.push(`- 模型：${t.model_name}`)
  lines.push(`- 类型：${kindLabel(t.kind)}`)
  lines.push(`- 协议：${t.api_format}`)
  lines.push(`- 状态：${statusLabel(t.status)}${t.http_status ? ` (HTTP ${t.http_status})` : ''}`)
  lines.push(`- 耗时：${fmtDuration(t.latency_ms)}`)
  if (cost) lines.push(`- 成本：${formatCost(cost.cny)}（${cost.formula}）`)
  lines.push(`- 创建时间：${fmtTime(t.created_at)}`)
  lines.push(`- 完成时间：${fmtTime(t.finished_at)}`)
  if (t.error_message) lines.push(`- 错误：${t.error_message}`)
  lines.push('')
  lines.push('## 提示词', '', '```', t.prompt || '', '```', '')
  if (t.params && Object.keys(t.params).length) {
    lines.push('## 参数', '', '```json', JSON.stringify(t.params, null, 2), '```', '')
  }
  lines.push('## 网络', '')
  lines.push('### 请求', '', '```json', safeJson(t.request_payload), '```', '')
  lines.push('### 响应', '', '```json', safeJson(t.response_payload), '```', '')
  return lines.join('\n')
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

function triggerDownload(bytes: Uint8Array, filename: string, type = 'application/zip') {
  const blob = new Blob([bytes as unknown as BlobPart], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(url)
}

// 直接下载一个远端 URL 为本地文件（不打包）。
// 先尝试同源 fetch 拿字节（R2 若开了 CORS 走这条，最快）；跨域被拦时走服务端下载代理
// （/api/assets/download 带 Content-Disposition: attachment），保证「存到本地」而非开新窗口。
async function triggerUrlDownload(url: string, filename: string) {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(String(res.status))
    const buf = new Uint8Array(await res.arrayBuffer())
    const type = res.headers.get('content-type') || 'application/octet-stream'
    triggerDownload(buf, filename, type)
  } catch {
    // 跨域 / CORS 失败：交给服务端代理强制下载（同源 URL，<a download> 生效）。
    const proxy = `/api/assets/download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`
    const a = document.createElement('a')
    a.href = proxy
    a.download = filename
    document.body.appendChild(a); a.click(); a.remove()
  }
}

import { trackAssetDownload } from './useAnalytics'

function slug(s: string): string {
  return (s || 'task').replace(/[^\w一-龥-]+/g, '_').slice(0, 40)
}

// 单任务下载（#7）：只下载生成结果本身（图片/视频），不打包、不带 readme/prompt/参考。
// 多结果则逐个下载；文本任务下载 result.md。
export async function downloadTaskZip(t: TaskRow, _model: Model | null = null) {
  trackAssetDownload('single_task', { task_id: t.id, model_name: t.model_name })
  const urls = taskResultUrls(t)
  const base = `relay-${t.id}-${slug(t.model_name)}`
  if (urls.length) {
    const ext = t.kind === 'image' ? 'png' : t.kind === 'video' ? 'mp4' : 'bin'
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]
      if (!url) continue
      const name = urls.length === 1 ? `${base}.${ext}` : `${base}-${i + 1}.${ext}`
      await triggerUrlDownload(url, name)
    }
    return
  }
  // 无媒体结果（如文本模型）：下载文本内容。
  if (t.result_text) {
    triggerDownload(strToU8(t.result_text), `${base}.md`, 'text/markdown')
  }
}

// 批量下载（#7）：一个压缩包。顶层放汇总 readme.md（所有任务概览+网络）+ prompt.txt
// （所有任务提示词），每个任务再单独一个文件夹（生成结果 + 参考素材 + 各自 readme/prompt）。
export async function downloadTasksZip(
  tasks: TaskRow[],
  resolveModel: (t: TaskRow) => Model | null = () => null,
) {
  if (!tasks.length) return
  trackAssetDownload('batch_tasks', { task_count: tasks.length })
  const progress = useDownloadProgress()
  // 总步数 = 每任务抓取一步 + 最后压缩一步。
  progress.start(tasks.length + 1, `打包下载 · ${tasks.length} 个任务`)
  try {
    const all: Record<string, Uint8Array> = {}
    let i = 0
    for (const t of tasks) {
      i++
      progress.label(`抓取任务 #${t.id}（${i}/${tasks.length}）`)
      const folder = `task-${t.id}-${slug(t.model_name)}/`
      const files = await collectTaskFiles(t, resolveModel(t), folder)
      Object.assign(all, files)
      progress.step()
    }
    // 顶层汇总文件
    all['readme.md'] = strToU8(buildBatchReadme(tasks, resolveModel))
    all['prompt.txt'] = strToU8(buildBatchPrompts(tasks))
    progress.label('压缩打包中…', true)
    const bytes = await zipAsync(all, 6)
    triggerDownload(bytes, `relay-tasks-${tasks.length}.zip`)
    progress.done()
  } catch (e) {
    progress.fail('打包失败')
    throw e
  }
}

// 汇总 readme：每个任务一段概览 + 网络，任务间用分隔线隔开。
function buildBatchReadme(tasks: TaskRow[], resolveModel: (t: TaskRow) => Model | null): string {
  const parts: string[] = []
  parts.push(`# 批量下载 · ${tasks.length} 个任务`, '', `导出时间：${fmtTime(Date.now())}`, '')
  parts.push('## 目录', '')
  for (const t of tasks) {
    parts.push(`- 任务 #${t.id} · ${t.provider_name} / ${t.model_name}（${statusLabel(t.status)}） → \`task-${t.id}-${slug(t.model_name)}/\``)
  }
  parts.push('')
  for (const t of tasks) {
    parts.push('---', '', buildReadme(t, resolveModel(t)), '')
  }
  return parts.join('\n')
}

// 汇总 prompt.txt：每个任务的提示词，标注任务号，任务间空行分隔。
function buildBatchPrompts(tasks: TaskRow[]): string {
  const blocks: string[] = []
  for (const t of tasks) {
    blocks.push(`# 任务 #${t.id} · ${t.provider_name} / ${t.model_name}`, t.prompt || '(空)', '')
  }
  return blocks.join('\n')
}
