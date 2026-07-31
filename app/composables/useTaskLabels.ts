/**
 * 任务状态 / 类型的中文标签与配色，集中一处维护。
 * 供任务列表、结果区 header、历史页、下载 readme 等复用，避免各处重复字面量。
 */
import type { TaskStatus, ModelKind } from '~~/types/api'

/** 状态中文：排队 / 请求中 / 成功 / 失败 */
export function statusLabel(s: string): string {
  return ({ pending: '排队', running: '请求中', succeeded: '成功', failed: '失败' } as Record<string, string>)[s] || s
}

/** 类型中文：生图 / 生视频 / 文本 */
export function kindLabel(k: string): string {
  return ({ image: '生图', video: '生视频', text: '文本' } as Record<string, string>)[k] || k
}

/** 状态胶囊底色 + 文字色（成功=主色，失败=红，其余=灰） */
export function statusPillClass(s: string): string {
  if (s === 'succeeded') return 'bg-primary-50 text-primary-700'
  if (s === 'failed') return 'bg-red-50 text-red-600'
  return 'bg-[var(--c-surface-3)] text-[var(--c-fg-4)]'
}

/** 状态圆点色（进行中呼吸动画） */
export function statusDotClass(s: string): string {
  if (s === 'succeeded') return 'bg-primary-500'
  if (s === 'failed') return 'bg-red-500'
  return 'bg-[var(--c-fg-6)] animate-pulse'
}

/** UBadge 用的语义色名 */
export function statusColor(s: string): 'neutral' | 'primary' | 'success' | 'error' {
  if (s === 'succeeded') return 'success'
  if (s === 'failed') return 'error'
  if (s === 'running' || s === 'pending') return 'primary'
  return 'neutral'
}
