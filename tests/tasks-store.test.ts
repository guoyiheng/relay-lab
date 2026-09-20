import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTasksStore } from '../app/stores/tasks'
import type { TaskRow } from '../types/api'

function audioTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 1, provider_id: 1, provider_name: 'Seed', model_id: 1, model_name: 'Seed Audio',
    kind: 'audio', api_format: 'seed-audio', prompt: 'hello', params: {},
    request_payload: { text_prompt: 'hello' }, response_payload: null,
    status: 'running', http_status: null, latency_ms: null, remote_task_id: null,
    result_urls: [], error_message: null, created_at: 100, updated_at: 100, finished_at: null,
    assets_expires_at: null, assets_cleaned_at: null, assets_cleanup_reason: null,
    refs: { image: [], video: [], audio: [] },
    ...overrides,
  }
}

function summary(task: TaskRow): TaskRow {
  const { refs, ...rest } = task
  return { ...rest, request_payload: null, response_payload: null }
}

describe('task detail response freshness', () => {
  const getTask = vi.fn()
  const listTasks = vi.fn()

  beforeEach(() => {
    setActivePinia(createPinia())
    getTask.mockReset()
    listTasks.mockReset()
    vi.stubGlobal('useDataSource', () => ({ getTask, listTasks }))
  })

  afterEach(() => {
    useTasksStore().stopAllPolls()
    vi.unstubAllGlobals()
  })

  it.each(['succeeded', 'failed'] as const)('loads the final response after a cached running task becomes %s', async (status) => {
    const store = useTasksStore()
    store.upsert(audioTask())
    const finished = audioTask({ status, updated_at: 200, response_payload: { code: status === 'succeeded' ? 0 : 400, message: status } })
    listTasks.mockResolvedValue([summary(finished)])
    getTask.mockResolvedValue(finished)

    store.polling.add(1)
    await store.pollTick()
    expect(store.detailById(1)?.status).toBe(status)
    expect(store.polling.size).toBe(0)
    expect((await store.loadDetail(1)).response_payload).toEqual(finished.response_payload)
    expect(store.detailById(1)?.response_payload).toEqual(finished.response_payload)
    await store.loadDetail(1)
    expect(getTask).toHaveBeenCalledTimes(1)
  })

  it('refreshes on status changes even when the timestamp is unchanged', async () => {
    const store = useTasksStore()
    store.upsert(audioTask())
    const finished = audioTask({ status: 'succeeded', response_payload: { url: 'https://example.com/audio.mp3' } })
    store.upsert(summary(finished))
    getTask.mockResolvedValue(finished)
    expect((await store.loadDetail(1)).response_payload).toEqual(finished.response_payload)
    expect(getTask).toHaveBeenCalledTimes(1)
  })

  it('refreshes an intermediate response when only the data version changes', async () => {
    const store = useTasksStore()
    store.upsert(audioTask())
    const newer = audioTask({ updated_at: 200, response_payload: { create: { id: 'remote-1' }, polls: [] } })
    store.upsert(summary(newer))
    getTask.mockResolvedValue(newer)
    expect((await store.loadDetail(1)).response_payload).toEqual(newer.response_payload)
  })

  it('keeps the old response during a failed reload and allows retrying the stale detail', async () => {
    const store = useTasksStore()
    store.upsert(audioTask({ response_payload: { message: 'processing' } }))
    const finished = audioTask({ status: 'succeeded', updated_at: 200, response_payload: { code: 0 } })
    store.upsert(summary(finished))
    getTask.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(finished)
    await expect(store.loadDetail(1)).rejects.toThrow('network')
    expect(store.detailById(1)?.response_payload).toEqual({ message: 'processing' })
    expect((await store.loadDetail(1)).response_payload).toEqual({ code: 0 })
  })

  it('reloads cached detail after refreshing the task list', async () => {
    const store = useTasksStore()
    store.upsert(audioTask())
    const finished = audioTask({ status: 'succeeded', updated_at: 200, response_payload: { code: 0 } })
    listTasks.mockResolvedValue([summary(finished)])
    getTask.mockResolvedValue(finished)
    await store.loadAll(true)
    expect((await store.loadDetail(1)).response_payload).toEqual({ code: 0 })
  })

  it('uses full offline updates directly and preserves responses on unchanged summaries', async () => {
    const store = useTasksStore()
    store.upsert(audioTask())
    const finished = audioTask({ status: 'succeeded', updated_at: 200, response_payload: { code: 0 } })
    store.upsert(finished)
    store.upsert(summary(finished))
    expect((await store.loadDetail(1)).response_payload).toEqual({ code: 0 })
    expect(getTask).not.toHaveBeenCalled()
    store.remove(1)
    expect(store.detailRevisions[1]).toBeUndefined()
  })
})
