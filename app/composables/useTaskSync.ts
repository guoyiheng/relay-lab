/**
 * 视频任务手动查询状态组合式函数。
 * 共享 syncing 状态，统一处理 toast 提示与 store 回写。
 */
import type { TaskRow } from '~~/types/api'
import { useNotify } from './useNotify'
import { useTasksStore } from '~/stores/tasks'

const syncingIds = ref(new Set<number>())

export function useTaskSync() {
  const notify = useNotify()
  const tasksStore = useTasksStore()

  function isSyncing(id: number | null | undefined): boolean {
    if (!id) return false
    return syncingIds.value.has(id)
  }

  async function syncTask(task: Pick<TaskRow, 'id' | 'kind' | 'remote_task_id'>): Promise<TaskRow | undefined> {
    if (!task.id || syncingIds.value.has(task.id)) return
    syncingIds.value = new Set([...syncingIds.value, task.id])
    try {
      const updated = await tasksStore.syncTask(task.id)
      if (updated.status === 'succeeded') {
        notify.success('查询完成', '视频任务已生成成功！')
      } else if (updated.status === 'failed') {
        notify.error('查询完成：任务失败', updated.error_message || '上游任务执行失败')
      } else {
        notify.info('查询完成', '上游任务仍在生成中，请稍后再次查询')
      }
      return updated
    } catch (err: any) {
      notify.error('查询失败', err?.data?.statusMessage || err?.statusMessage || err?.message || '无法查询任务状态')
    } finally {
      const next = new Set(syncingIds.value)
      next.delete(task.id)
      syncingIds.value = next
    }
  }

  return {
    isSyncing,
    syncTask,
  }
}
