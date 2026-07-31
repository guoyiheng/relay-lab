import type { TaskRow } from '~~/types/api'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

export interface AssetRetentionInfo {
  state: 'permanent' | 'active' | 'due' | 'cleaned'
  label: string
  detail: string
}

function remainingLabel(ms: number): string {
  if (ms <= 0) return '已到期'
  const days = Math.floor(ms / DAY_MS)
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS)
  if (days > 0) return `${days} 天${hours > 0 ? ` ${hours} 小时` : ''}`
  if (hours > 0) return `${hours} 小时`
  return '不足 1 小时'
}

export function assetRetentionInfo(
  task: Pick<
    TaskRow,
    'kind' | 'result_urls' | 'refs' | 'assets_expires_at' | 'assets_cleaned_at' | 'assets_cleanup_reason'
  >,
  now = Date.now(),
): AssetRetentionInfo {
  if (task.assets_cleaned_at) {
    return {
      state: 'cleaned',
      label: '素材已清理',
      detail: task.assets_cleanup_reason || '素材已按保留策略自动清理，任务记录仍然保留。',
    }
  }
  const hasReferences = !!task.refs && (task.refs.image.length + task.refs.video.length + task.refs.audio.length > 0)
  const hasMedia = task.kind !== 'text' || !!task.result_urls?.length || hasReferences
  if (!task.assets_expires_at || !hasMedia) {
    return { state: 'permanent', label: '长期保留', detail: '' }
  }
  const remaining = task.assets_expires_at - now
  if (remaining <= 0) {
    return {
      state: 'due',
      label: '素材已到期，等待清理',
      detail: '系统将在下一次定时清理中删除素材，任务记录仍然保留。',
    }
  }
  return {
    state: 'active',
    label: `素材将在 ${remainingLabel(remaining)}后清理`,
    detail: '测试素材仅保留 7 天，请及时下载需要的结果。',
  }
}

export function taskStatusLabel(task: Pick<TaskRow, 'status' | 'assets_cleaned_at'>): string {
  return task.assets_cleaned_at ? '素材已清理' : statusLabel(task.status)
}

export function taskStatusPillClass(task: Pick<TaskRow, 'status' | 'assets_cleaned_at'>): string {
  return task.assets_cleaned_at
    ? 'bg-[var(--c-surface-3)] text-[var(--c-fg-4)]'
    : statusPillClass(task.status)
}

export function taskStatusDotClass(task: Pick<TaskRow, 'status' | 'assets_cleaned_at'>): string {
  return task.assets_cleaned_at ? 'bg-[var(--c-fg-6)]' : statusDotClass(task.status)
}

export function taskStatusColor(task: Pick<TaskRow, 'status' | 'assets_cleaned_at'>): 'neutral' | 'primary' | 'success' | 'error' {
  return task.assets_cleaned_at ? 'neutral' : statusColor(task.status)
}
