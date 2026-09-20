import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const records = vi.hoisted(() => new Map<string, any>())
vi.mock('../app/datasource/idb', () => ({ idb: {
  get: async (store: string, id: number) => structuredClone(records.get(`${store}:${id}`)),
  put: async (store: string, row: any) => { records.set(`${store}:${row.id}`, structuredClone(row)) },
} }))
import { syncOfflineTask } from '../app/datasource/offline-task'

beforeEach(() => {
  records.clear()
  records.set('tasks:1', {
    id: 1, provider_id: 1, model_id: 1, kind: 'video', api_format: 'doubao-video',
    remote_task_id: 'remote-1', status: 'failed', error_message: 'local timeout',
    finished_at: 2, created_at: 1, latency_ms: 1, http_status: 500,
    response_payload: { poll_url: 'https://example.com/tasks/remote-1', polls: [] },
  })
  records.set('providers:1', { id: 1, api_key: 'test-key' })
  records.set('models:1', { id: 1, keys: [] })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('offline manual sync', () => {
  it('recovers a failed task and resumes only polling the same remote task', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ kind: 'continue', poll: { status: 'running' } })
      .mockImplementation(() => new Promise(() => {}))
    vi.stubGlobal('$fetch', fetchMock)
    const recovered = await syncOfflineTask(1)
    expect(recovered).toMatchObject({ status: 'running', error_message: null, finished_at: null, latency_ms: null, http_status: null })
    expect((recovered.response_payload as any).polls).toEqual([{ status: 'running' }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every(([url]) => url === '/api/proxy/poll')).toBe(true)
  })

  it.each(['transient', 'error'])('throws for %s without changing the stored task', async (kind) => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ kind, result: { error_message: 'query failed' } }))
    await expect(syncOfflineTask(1)).rejects.toThrow()
    expect(records.get('tasks:1')).toMatchObject({ status: 'failed', error_message: 'local timeout', finished_at: 2 })
  })
})
